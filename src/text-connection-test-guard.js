export const createTextConnectionTestGuard = () => {
  let sequence = 0;
  let active = null;

  const cancel = () => {
    sequence += 1;
    active?.controller.abort();
    active = null;
  };

  const begin = ({ profileId = "", profileSignature = "" } = {}) => {
    cancel();
    const run = {
      sequence,
      profileId: String(profileId || ""),
      profileSignature: String(profileSignature || ""),
      controller: new AbortController(),
    };
    active = run;
    return run;
  };

  const matches = (run, { profileId = "", profileSignature = "" } = {}) => Boolean(
    run
    && active === run
    && run.sequence === sequence
    && run.profileId === String(profileId || "")
    && run.profileSignature === String(profileSignature || ""),
  );

  const finish = (run) => {
    if (active !== run) return false;
    active = null;
    return true;
  };

  return { begin, cancel, finish, matches };
};
