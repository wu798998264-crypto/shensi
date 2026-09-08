export const shouldRefreshLocalSession = ({ status = 0, errorCode = "", alreadyRetried = false } = {}) => (
  Number(status) === 403
  && String(errorCode || "") === "LOCAL_SESSION_EXPIRED"
  && alreadyRetried !== true
);
