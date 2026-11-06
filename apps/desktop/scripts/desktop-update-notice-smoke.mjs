export const verifyDisabledDesktopUpdateNotice = async (getState) => {
  const state = await getState();
  if (
    !state ||
    state.status !== "disabled" ||
    state.release !== null ||
    typeof state.installedVersion !== "string"
  ) {
    throw new Error(
      "Private packaged smoke expected disabled update notice state."
    );
  }
  return state;
};
