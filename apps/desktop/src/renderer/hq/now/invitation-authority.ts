/** A first accepted invitation may establish a Team principal for the same local identity. */
export const sameInvitationAuthority = (
  before: string,
  after: string | null,
  allowFirstPrincipal: boolean
): boolean => {
  if (!after) return false;
  let prior: unknown;
  let current: unknown;
  try {
    prior = JSON.parse(before);
    current = JSON.parse(after);
  } catch {
    return false;
  }
  if (
    !Array.isArray(prior) ||
    !Array.isArray(current) ||
    prior.length !== 6 ||
    current.length !== 6 ||
    ![0, 1, 2, 4, 5].every(
      (index) =>
        typeof prior[index] === "string" && prior[index] === current[index]
    )
  )
    return false;
  return (
    prior[3] === current[3] ||
    (allowFirstPrincipal &&
      prior[3] === null &&
      typeof current[3] === "string" &&
      current[3].length > 0)
  );
};
