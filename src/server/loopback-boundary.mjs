import { BlockList, isIP } from "node:net";

const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_REMOTE_ADDRESSES = new BlockList();
LOOPBACK_REMOTE_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_REMOTE_ADDRESSES.addAddress("::1", "ipv6");
LOOPBACK_REMOTE_ADDRESSES.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

const boundaryError = (message, code, statusCode = 403) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const normalizedPort = (port) => {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw boundaryError("本地服务端口必须是 1 到 65535 之间的整数", "INVALID_LOCAL_PORT", 400);
  }
  return value;
};

export const assertLoopbackBindHost = (host) => {
  const value = String(host ?? "");
  const normalized = value.toLowerCase();
  if (!LOOPBACK_BIND_HOSTS.has(normalized)) {
    throw boundaryError(
      "神思本地服务只允许绑定 127.0.0.1、localhost 或 ::1",
      "NON_LOOPBACK_BIND_HOST",
      400,
    );
  }
  return normalized;
};

export const assertLocalServicePort = (port) => normalizedPort(port);

export const isLoopbackRemoteAddress = (remoteAddress) => {
  const value = String(remoteAddress ?? "").toLowerCase();
  const family = isIP(value);
  if (family === 4) return LOOPBACK_REMOTE_ADDRESSES.check(value, "ipv4");
  if (family === 6) return LOOPBACK_REMOTE_ADDRESSES.check(value, "ipv6");
  return false;
};

export const allowedLoopbackAuthorities = (port) => {
  const value = normalizedPort(port);
  return new Set([
    `127.0.0.1:${value}`,
    `localhost:${value}`,
    `[::1]:${value}`,
  ]);
};

const rawHeaderCount = (rawHeaders, expectedName) => {
  if (!Array.isArray(rawHeaders)) return null;
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index] ?? "").toLowerCase() === expectedName) count += 1;
  }
  return count;
};

export const assertLoopbackRequestBoundary = (request, { port }) => {
  if (!isLoopbackRemoteAddress(request?.socket?.remoteAddress)) {
    throw boundaryError("拒绝非本机连接", "NON_LOOPBACK_REMOTE");
  }

  const hostCount = rawHeaderCount(request?.rawHeaders, "host");
  if (hostCount !== null && hostCount !== 1) {
    throw boundaryError("请求必须包含且只能包含一个本地主机 Host", "INVALID_HOST_COUNT");
  }

  const hostHeader = typeof request?.headers?.host === "string" ? request.headers.host.toLowerCase() : "";
  if (!allowedLoopbackAuthorities(port).has(hostHeader)) {
    throw boundaryError("拒绝主机或端口不匹配的请求", "INVALID_LOCAL_HOST");
  }

  const originHeader = request?.headers?.origin;
  if (originHeader !== undefined) {
    if (typeof originHeader !== "string" || originHeader.toLowerCase() !== `http://${hostHeader}`) {
      throw boundaryError("拒绝非同源请求", "INVALID_LOCAL_ORIGIN");
    }
  }

  return { hostHeader, origin: `http://${hostHeader}` };
};
