import { connect as connectTls } from 'node:tls';
import { isIP } from 'node:net';
// Server-only SMTP adapter. Never logs credentials, mail bodies or provider errors.
export const createEmailDelivery = (environment = process.env) => {
  const user = String(environment.SHENSI_CLOUD_SMTP_USER || '').trim();
  const password = String(environment.SHENSI_CLOUD_SMTP_PASSWORD || '');
  const host = String(environment.SHENSI_CLOUD_SMTP_HOST || 'smtp.qq.com').trim();
  const port = Number(environment.SHENSI_CLOUD_SMTP_PORT || 465);
  const name = String(environment.SHENSI_CLOUD_SMTP_FROM_NAME || '神思').trim();
  const configured = Boolean(user && password && host && Number.isInteger(port) && port > 0 && port <= 65535
    && !/[\r\n<>;,]/u.test(user) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(user));
  const active = new Set(); const sockets = new Set();
  return {
    configured,
    close: () => { for (const socket of sockets) socket.destroy(); for (const transport of active) transport.close(); active.clear(); },
    send: async ({ to, code, purpose, signal }) => {
      if (!configured) throw new Error('发信服务未配置');
      const { default: nodemailer } = await import('nodemailer');
      let connection;
      const transport = nodemailer.createTransport({
        host, port, secure: true, auth: { user, pass: password },
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
        logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
        getSocket: (_options, done) => {
          let handedOff = false;
          connection = connectTls({ host, port, ...(isIP(host) ? {} : { servername: host }), minVersion: 'TLSv1.2', rejectUnauthorized: true });
          sockets.add(connection);
          const finish = (error) => { if (handedOff) return; handedOff = true; done(error, error ? undefined : { connection, secured: true }); };
          connection.once('secureConnect', () => { connection.setTimeout(8000); finish(null); });
          connection.once('error', finish);
          connection.once('close', () => { sockets.delete(connection); finish(new Error('SMTP connection closed')); });
          connection.setTimeout(5000, () => connection.destroy(new Error('SMTP connection timeout')));
          if (signal?.aborted) connection.destroy(new Error('SMTP request cancelled'));
        },
      });
      active.add(transport);
      const abort = () => { connection?.destroy(new Error('SMTP request cancelled')); transport.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const action = purpose === 'bind' ? '验证绑定邮箱' : '登录神思';
        const result = await transport.sendMail({
          from: { name, address: user }, to: { address: to },
          subject: '神思邮箱验证码',
          text: '你正在' + action + '，验证码为：' + code + '\n\n'
            + '验证码 5 分钟内有效，只能使用一次。请勿向任何人透露此验证码。\n'
            + '如果这不是你的操作，请忽略本邮件。\n\n神思',
        });
        if (!result.accepted?.some((address) => String(address).toLowerCase() === to)) throw new Error('邮件未被接收');
      } finally { signal?.removeEventListener('abort', abort); connection?.destroy(); transport.close(); active.delete(transport); }
    },
  };
};
