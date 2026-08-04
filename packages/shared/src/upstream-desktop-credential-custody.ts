export {
  DESKTOP_LOCAL_CREDENTIAL_OPERATION_FAMILIES,
  deleteDesktopLocalCredential,
  deleteUpstreamCredentialSecret,
  desktopLocalCredentialReferenceFor,
  parseUpstreamCredentialReference,
  readDesktopLocalCredentialAuthorization,
  readUpstreamCredentialAuthorization,
  rotateDesktopLocalCredential,
  storeDesktopLocalCredential,
  storeEnrollmentCredentialCustody,
  storeUpstreamCredentialSecret,
  upstreamCredentialReferenceFor,
  verifyDesktopLocalCredentialAuthorization
} from "./encrypted-state-custody-internal.js";
export type {
  DesktopLocalCredentialAuthorization,
  DesktopLocalCredentialInput,
  DesktopLocalCredentialOperationFamily,
  EnrollmentCredentialCustodyInput,
  EnrollmentCredentialCustodyResult,
  UpstreamCredentialSecretInput,
  UpstreamCredentialSecretStoreDeps
} from "./encrypted-state-custody-internal.js";
