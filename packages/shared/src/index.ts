import { createHash } from "node:crypto";

export {
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_AGGREGATE_FIELD_LIMIT,
  PRIVACY_CLASSIFICATION_REQUEST_FIELD_LIMIT,
  PRIVACY_REPLACEMENT_CONTRACT_VERSION,
  allPrivacyLabelsPolicy,
  derivePrivacyFingerprintKey,
  noPrivacyLabelsPolicy,
  privacyClassificationAggregateResponseSchema,
  privacyClassificationFieldRequestSchema,
  privacyClassificationRequestSchema,
  privacyClassificationResponseSchema,
  privacyClassifiedFieldSchema,
  privacyClassifierHash,
  privacyContentPolicyHash,
  privacyDetectedSpanSchema,
  privacyLabelPolicySchema,
  privacyLabelSchema,
  privacyLabels,
  resolveEffectivePrivacyPolicy,
  sanitizeTextWithPrivacySpans
} from "./privacy-filter-contract.js";
export type {
  PrivacyClassificationFieldRequest,
  PrivacyClassificationRequest,
  PrivacyClassificationResponse,
  PrivacyClassifiedField,
  PrivacyDetectedSpan,
  PrivacyLabel,
  PrivacyLabelPolicy,
  SanitizedPrivacyText
} from "./privacy-filter-contract.js";
export {
  PINNED_PRIVACY_ARTIFACT_SHA256,
  PINNED_PRIVACY_CALIBRATION_SHA256,
  PINNED_PRIVACY_CLASSIFIER_GENERATION,
  PINNED_PRIVACY_CLASSIFIER_HASH,
  PINNED_PRIVACY_CONFIG_SHA256,
  PINNED_PRIVACY_DECODER_SHA256,
  PINNED_PRIVACY_DETERMINISTIC_DETECTOR_VERSION,
  PINNED_PRIVACY_MODEL_FILES,
  PINNED_PRIVACY_MODEL_ID,
  PINNED_PRIVACY_MODEL_REVISION,
  PINNED_PRIVACY_Q4_DATA_SHA256,
  PINNED_PRIVACY_Q4_DATA_SIZE,
  PINNED_PRIVACY_Q4_ONNX_SHA256,
  PINNED_PRIVACY_Q4_ONNX_SIZE,
  PINNED_PRIVACY_TOKENIZER_CONFIG_SHA256,
  PINNED_PRIVACY_TOKENIZER_SHA256
} from "./privacy-classifier-generation.js";
export {
  createPrivacyServiceClient,
  PrivacyServiceContractError,
  PrivacyServiceUnavailableError
} from "./privacy-service-client.js";
export type {
  PrivacyServiceClient,
  PrivacyServiceClientOptions
} from "./privacy-service-client.js";
export {
  DEFAULT_PRIVACY_FIELD_LIMITS,
  extractPrivacyTextFields,
  isFullyRedactedPrivacyText,
  PrivacyFieldError,
  reconstructPrivacyTextFields
} from "./privacy-field-extractor.js";
export type {
  ExtractedPrivacyTextField,
  MaskedPrivacyTextField,
  PrivacyArrayFieldSchema,
  PrivacyFieldErrorCode,
  PrivacyFieldLimits,
  PrivacyFieldReconstruction,
  PrivacyFieldSchema,
  PrivacyFieldSource,
  PrivacyJsonPrimitive,
  PrivacyJsonValue,
  PrivacyLiteralFieldSchema,
  PrivacyObjectFieldSchema,
  PrivacyScalarFieldSchema,
  PrivacyTupleFieldSchema,
  PrivacyTextFieldSchema
} from "./privacy-field-extractor.js";
export {
  CodexTeamSourcePrivacyError,
  prepareCodexTeamSourceRecord,
  reconstructCodexTeamSourceRecord,
  serializeCodexTeamSourceRecord
} from "./codex-team-source-privacy.js";
export type {
  CodexTeamSourceDropReason,
  PreparedCodexTeamSourceRecord
} from "./codex-team-source-privacy.js";
export {
  intersectSharedMemoryFidelityCeilings,
  sharedMemoryCeilingAuthorizes,
  sharedMemoryFidelityCeilings,
  sharedMemoryRepresentationsForCeiling
} from "./shared-memory-fidelity.js";
export type {
  HierarchicalSharedMemoryRepresentation,
  SharedMemoryFidelityCeiling
} from "./shared-memory-fidelity.js";

// Internal bootstrap identity shared by local capture and Desktop credentials.
export const LOCAL_PERSONAL_USER_EMAIL = "local@koed.ai";

export {
  decideHistoricalAdmission,
  type HistoricalAdmissionDecision,
  type HistoricalAdmissionInput,
  type HistoricalAdmissionPauseReason,
  type HistoricalImportBatchConfig
} from "./historical-admission.js";

export {
  aiClientSourceAdapterRegistry,
  assertSupportedAiClientSourceAdapter,
  isPrivacyMaterializationSourceAdapter,
  isSupportedAiClientSourceAdapter,
  privacyMaterializationSourceAdapters,
  resolveAiClientSourceAdapter
} from "./ai-client-source-adapters.js";
export type {
  AiClientSourceAdapter,
  AiClientSourceAdapterCandidate,
  AiClientSourceAdapterVersion,
  AiClientSourceArtifactFormat,
  AiClientSourceArtifactFormatVersion,
  AiClientSourceKind,
  AiClientSourceRuntime
} from "./ai-client-source-adapters.js";
export {
  aiClientCapabilityIds,
  aiClientDiagnosticCodeMaxLength,
  aiClientDiagnosticMessageMaxLength,
  aiClientDriverIdMaxLength,
  aiClientIdentifierPattern,
  aiClientInstanceIdMaxLength,
  assertAiClientDriverId,
  assertAiClientInstanceId,
  defaultAiClientInstanceId,
  isSupportedAiClientDriverId,
  supportedAiClientDriverIds,
  aiClientModelLabel,
  sanitizeAiClientDiagnostics
} from "./ai-client-contract.js";
export type {
  AiClientCapabilityDescriptor,
  AiClientCapabilityId,
  AiClientCapabilityReadiness,
  AiClientCapabilitySnapshot,
  AiClientCapabilitySupport,
  AiClientDiagnostic,
  AiClientDiagnosticSeverity,
  AiClientDriverId,
  AiClientExecutionTarget,
  AiClientInstanceId,
  AiClientModelCapability,
  AiClientModelIdentity,
  AiClientModelProvenance,
  AiClientRecoveryAction,
  AiClientRecoveryActionId,
  SupportedAiClientDriverId
} from "./ai-client-contract.js";
export {
  codeDefaultAssignmentFor,
  documentDefault,
  environmentDefaultFor,
  localAiClientDefaultSpec,
  localAiClientFlowKeys
} from "./ai-client-flow-defaults.js";
export type {
  LocalAiClientDefault,
  LocalAiClientFlowKey,
  LocalAiClientRuntimeAssignment
} from "./ai-client-flow-defaults.js";

export {
  resolveTeamCollaborationEnabled,
  teamCollaborationFeatureEnvironmentName
} from "./team-collaboration-feature.js";
export {
  coarsePresenceFromTeamPresence,
  deriveTeamPresenceSnapshot,
  isTeamManualStatus,
  TEAM_ACTIVITY_ACTIVE_MS,
  TEAM_ACTIVITY_IDLE_MS,
  TEAM_ACTIVITY_RECENT_MS,
  TEAM_ACTIVITY_WRITE_THROTTLE_MS,
  TEAM_PRESENCE_STATUS_CATALOGUE_VERSION,
  teamActivityLevels,
  teamManualStatuses,
  teamPresenceStatusCatalogue,
  teamPresenceModes
} from "./team-presence.js";
export type {
  TeamActivityLevel,
  TeamManualStatus,
  TeamManualStatusDisplay,
  TeamPresenceMode,
  TeamPresenceSnapshot,
  TeamPresenceStatusCatalogue
} from "./team-presence.js";

export {
  assertConversationSourceReplicationJsonlSegment,
  CONVERSATION_SOURCE_DOWNLOAD_AUTHORIZATION_TTL_MS,
  CONVERSATION_SOURCE_REPLICATION_MAX_SEGMENT_BYTES,
  CONVERSATION_SOURCE_REPLICATION_PROTOCOL,
  CONVERSATION_SOURCE_COMPONENT_SCHEMA_VERSION,
  assertConversationSourceOriginKeyAcceptsManifest,
  calculateConversationSourceDownloadRequestHash,
  calculateConversationSourceDownloadScopeHash,
  calculateConversationSourceClosureDigest,
  calculateConversationSourceClosureOperationContentDigest,
  calculateConversationSourceDiscoveryRequestHash,
  calculateConversationSourceDiscoveryScopeHash,
  calculateConversationSourceGenerationRegistrationDigest,
  calculateConversationSourceOriginKeyRegistrationDigest,
  calculateConversationSourceRootDigest,
  calculateConversationSourceComponentSetDigest,
  calculateConversationSourceSetClosureDigest,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceReplicationOperationDigest,
  calculateConversationSourceReplicationPlaintextDigest,
  canonicalizeConversationSourceClosureManifest,
  canonicalizeConversationSourceSetClosureManifest,
  canonicalizeConversationSourceReplicationManifest,
  conversationSourceOriginKeyLifecycles,
  exportConversationSourceReplicationPublicKey,
  generateConversationSourceReplicationOriginKeyPair,
  importConversationSourceReplicationPublicKey,
  parseCanonicalConversationSourceReplicationManifestJson,
  parseConversationSourceClosureManifest,
  parseConversationSourceOriginKeyPin,
  parseConversationSourceOriginKeyRegistration,
  parseConversationSourceReplicationManifest,
  parseConversationSourceReplicationSegmentEnvelope,
  parseConversationSourceReplicationSourceDescriptor,
  parseConversationSourceSetClosureManifest,
  parseSignedConversationSourceClosureManifest,
  parseSignedConversationSourceReplicationManifest,
  parseSignedConversationSourceSetClosureManifest,
  signConversationSourceClosureManifest,
  signConversationSourceReplicationManifest,
  signConversationSourceSetClosureManifest,
  verifyConversationSourceClosureManifestSignature,
  verifyConversationSourceReplicationManifestForAcceptance,
  verifyConversationSourceReplicationManifestSignature,
  verifyConversationSourceSetClosureManifestSignature
} from "./conversation-source-replication.js";
export type {
  ConversationSourceComponentIdentity,
  ConversationSourceComponentRole,
  ConversationSourceContentFraming,
  ConversationSourceClosureManifest,
  ConversationSourceOriginKeyLifecycle,
  ConversationSourceOriginKeyPair,
  ConversationSourceOriginKeyPin,
  ConversationSourceOriginKeyRegistration,
  ConversationSourcePriorGenerationClosure,
  ConversationSourceReplicationManifest,
  ConversationSourceReplicationSegmentEnvelope,
  ConversationSourceReplicationSourceDescriptor,
  ConversationSourceSetClosureManifest,
  ConversationSourceSetClosureMember,
  SignedConversationSourceClosureManifest,
  SignedConversationSourceReplicationManifest,
  SignedConversationSourceSetClosureManifest
} from "./conversation-source-replication.js";
export {
  MANAGED_CONVERSATION_TARGET_READINESS_PROTOCOL,
  MANAGED_CONVERSATION_TRANSFER_PROTOCOL,
  MANAGED_CONVERSATION_TRANSFER_PROTOCOL_V2,
  assertManagedConversationHandoffTransition,
  canonicalManagedConversationTargetReadinessEvidence,
  canonicalManagedConversationHandoffManifest,
  managedConversationAiClientInstanceIdAfterVerification,
  countersignManagedConversationHandoffCertificate,
  createManagedConversationAuthorityPrivateKey,
  managedConversationAuthorityLogHead,
  managedConversationHandoffCertificateDigest,
  managedConversationHandoffStates,
  managedConversationTargetReadinessDimensions,
  managedConversationTargetReadinessEvidenceDigest,
  managedConversationTargetReadinessIsFresh,
  parseManagedConversationHandoffCertificate,
  parseManagedConversationHandoffManifest,
  parseManagedConversationTargetReadinessEvidence,
  signManagedConversationHandoffCertificate,
  verifyManagedConversationHandoffCertificate,
  verifyManagedConversationHandoffSourceAttestation
} from "./managed-conversation-transfer.js";
export {
  MANAGED_CONVERSATION_FORK_PROTOCOL,
  MANAGED_CONVERSATION_FORK_PROTOCOL_V2,
  canonicalManagedConversationForkManifest,
  managedConversationForkAiClientInstanceIdAfterVerification,
  managedConversationForkManifestDigest,
  parseManagedConversationForkManifest,
  parseSignedManagedConversationForkManifest,
  verifyManagedConversationForkManifest
} from "./managed-conversation-fork.js";
export type {
  ManagedConversationForkManifest,
  SignedManagedConversationForkManifest
} from "./managed-conversation-fork.js";
export type {
  ManagedConversationHandoffCertificate,
  ManagedConversationHandoffManifest,
  ManagedConversationHandoffState,
  ManagedConversationReadinessProof,
  ManagedConversationTargetReadinessDimension,
  ManagedConversationTargetReadinessEvidence
} from "./managed-conversation-transfer.js";
export {
  activeUpstreamBackend,
  readLocalEdgeUpstreamEnrollmentBinding,
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamBackendById
} from "./local-edge-upstream-registry.js";
export type {
  LocalEdgeUpstreamBackend,
  LocalEdgeUpstreamEnrollmentBinding,
  LocalEdgeUpstreamRegistry,
  LocalEdgeUpstreamRoutePolicyKey
} from "./local-edge-upstream-registry.js";

export {
  approvalDecisionDisplaySchema,
  approvalReviewTranscriptDisplayFromText,
  approvalReviewTranscriptDisplaySchema,
  approvalReviewTranscriptSegmentSchema,
  isApprovalReviewTranscriptEnvelopeText,
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT,
  PERSONAL_DESKTOP_OLDER_EVENT_LIMIT,
  personalDesktopConversationCursorSchema,
  personalDesktopConversationEventSchema,
  personalDesktopChangeEventRefSchema,
  personalDesktopChangeSchema,
  personalDesktopErrorSchema,
  personalDesktopEventPageInputSchema,
  personalDesktopEventsDataSchema,
  personalDesktopProjectMetadataDataSchema,
  personalDesktopProjectMetadataSchema,
  personalDesktopProjectSchema,
  personalDesktopProjectsDataSchema,
  personalDesktopProjectThreadSchema,
  personalDesktopRequestSchema,
  personalDesktopResultSchema,
  personalDesktopSessionProjectDataSchema,
  personalDesktopSessionProjectInputSchema,
  personalDesktopSessionTitleDataSchema,
  personalDesktopSessionTitleInputSchema,
  personalDesktopToolDisplaySchema
} from "./personal-desktop-contract.js";
export {
  approvalActivityClassificationSchema,
  approvalActivityDisplaySchema,
  approvalActivityExclusionReasonSchema,
  approvalActivityKindSchema,
  approvalActivityMetadata,
  classifyApprovalActivity
} from "./approval-activity.js";
export type {
  ApprovalActivityClassification,
  ApprovalActivityDisplay,
  ApprovalActivityExclusionReason,
  ApprovalActivityKind
} from "./approval-activity.js";
export type {
  ApprovalDecisionDisplay,
  ApprovalReviewTranscriptDisplay,
  ApprovalReviewTranscriptSegment,
  PersonalDesktopApi,
  PersonalDesktopConversationCursor,
  PersonalDesktopConversationEvent,
  PersonalDesktopChange,
  PersonalDesktopEventPageInput,
  PersonalDesktopProjectMetadata,
  PersonalDesktopProject,
  PersonalDesktopProjectThread,
  PersonalDesktopRequest,
  PersonalDesktopResult,
  PersonalDesktopSessionProjectInput,
  PersonalDesktopSessionTitleInput
} from "./personal-desktop-contract.js";

export {
  calculateCollaborationReconnectDelay,
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  COLLABORATION_DECRYPT_BATCH_MAX_ITEMS,
  COLLABORATION_DEPLOYMENT_MESSAGE_MAX_PER_MINUTE,
  COLLABORATION_DISPLAY_NAME_MAX_CODE_POINTS,
  COLLABORATION_CONNECTION_ATTEMPT_MAX_PER_MINUTE,
  COLLABORATION_CHANNEL_CREATION_MAX_PER_HOUR,
  COLLABORATION_HISTORY_PAGE_MAX_ITEMS,
  COLLABORATION_INVITE_CREATION_MAX_PER_HOUR,
  COLLABORATION_MAX_DM_PARTICIPANTS,
  COLLABORATION_MESSAGE_BURST_MAX_COUNT,
  COLLABORATION_MESSAGE_BURST_WINDOW_MS,
  COLLABORATION_MESSAGE_MAX_UTF8_BYTES,
  COLLABORATION_MESSAGE_SUSTAINED_MAX_COUNT,
  COLLABORATION_MESSAGE_SUSTAINED_WINDOW_MS,
  COLLABORATION_NAME_MAX_CODE_POINTS,
  COLLABORATION_REALTIME_CURSOR_MAX_BYTES,
  COLLABORATION_RECONNECT_BACKOFF_CAP_MS,
  COLLABORATION_RECONNECT_MAX_ATTEMPTS,
  COLLABORATION_RECONNECT_UNAVAILABLE_COOLDOWN_MS,
  COLLABORATION_RECONNECT_WINDOW_MS,
  COLLABORATION_RENDERED_ROW_MAX_COUNT,
  COLLABORATION_RENDERER_ACK_DEADLINE_MS,
  COLLABORATION_RENDERER_MAX_PENDING_BYTES,
  COLLABORATION_RENDERER_MAX_PENDING_EVENTS,
  COLLABORATION_SEND_RETRY_MAX_ATTEMPTS,
  COLLABORATION_SOURCE_PAGE_MAX_ITEMS,
  COLLABORATION_SPLIT_VIEW_BREAKPOINT_PX,
  COLLABORATION_SPLIT_VIEW_DISCUSSION_MIN_PX,
  COLLABORATION_SPLIT_VIEW_SOURCE_MIN_PX,
  COLLABORATION_TEAM_MESSAGE_MAX_PER_MINUTE,
  COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES,
  collaborationActionGrantIntentSchema,
  collaborationActionGrantReferenceSchema,
  collaborationActionGrantStatusSchema,
  collaborationApprovalReviewSchema,
  collaborationApprovalTierSchema,
  collaborationBackendIdentitySchema,
  collaborationCommandResultSchema,
  collaborationConnectionEventSchema,
  collaborationDurableSendAuthoritySchema,
  collaborationDurableSendEventSchema,
  collaborationDurableSendSchema,
  collaborationConnectionSchema,
  isPersonalCollaborationSelection,
  isTeamCollaborationSelection,
  collaborationDeliveryIdSchema,
  collaborationDisplayNameSchema,
  collaborationIdentifierSchema,
  collaborationInvitationPageSchema,
  collaborationInvitationSchema,
  collaborationLimitsSchema,
  collaborationMessageBodySchema,
  collaborationMessagePageSchema,
  collaborationMessageSchema,
  collaborationMembershipSchema,
  collaborationNameSchema,
  collaborationOpaqueCursorSchema,
  personalMemoryEntrySchema,
  collaborationPersonSchema,
  collaborationReadStateSchema,
  collaborationRealtimeControlSchema,
  collaborationRealtimeCursorSchema,
  collaborationRealtimeEventFamilySchema,
  collaborationRealtimeSnapshotSchema,
  collaborationRemoteBackendUrlSchema,
  collaborationCommandReturnsSnapshot,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  collaborationRendererUpdateSchema,
  collaborationSnapshotResultCommands,
  collaborationSafeErrorSchema,
  collaborationSafeErrorMessages,
  collaborationSelectionSchema,
  collaborationSnapshotSchema,
  collaborationSubscriptionSchema,
  collaborationTeamPersonSchema,
  collaborationTeamPresenceStatusCatalogueSchema,
  collaborationThreadSchema,
  collaborationThreadReferenceSchema,
  collaborationTimestampSchema,
  collaborationTopicDescriptionSchema,
  collaborationViewSchema,
  collaborationWorkspaceSchema,
  collaborationWorkspaceAccessSchema,
  sharedMemoryConsentSchema,
  sharedMemoryEventSourceKindSchema,
  sharedMemoryRepresentationSchema,
  sharedMemoryGrantSchema,
  pendingShareSchema,
  ownedShareSummarySchema,
  ownedShareItemSchema,
  conversationSourceAccessSchema,
  sharedMemoryPreviewSchema,
  sharedMemoryCandidatePreviewSchema,
  sharedMemorySessionSchema,
  sharedMemorySessionReferenceSchema,
  sharedMemorySourceItemSchema,
  sharedMemorySourcePageSchema
} from "./collaboration-contract.js";
export type {
  CollaborationActionGrantIntent,
  CollaborationActionGrantReference,
  CollaborationActionGrantStatus,
  CollaborationApprovalReview,
  CollaborationApprovalTier,
  CollaborationBackendIdentity,
  CollaborationCommandResult,
  CollaborationConnection,
  CollaborationDurableSend,
  CollaborationLimits,
  CollaborationMessage,
  CollaborationMessagePage,
  PersonalMemoryEntry,
  OwnedShareItem,
  CollaborationMembership,
  CollaborationInvitation,
  CollaborationInvitationPage,
  CollaborationPerson,
  CollaborationTeamPerson,
  CollaborationReadState,
  CollaborationRealtimeControl,
  CollaborationRealtimeSnapshot,
  CollaborationRendererCommand,
  CollaborationRendererEvent,
  CollaborationSafeError,
  CollaborationSelection,
  CollaborationSnapshot,
  CollaborationSubscription,
  CollaborationThread,
  CollaborationThreadReference,
  CollaborationView,
  CollaborationWorkspace,
  CollaborationWorkspaceAccess,
  SharedMemoryConsent,
  SharedMemoryGrant,
  PendingShare,
  ConversationSourceAccess,
  SharedMemoryPreview,
  SharedMemoryCandidatePreview,
  SharedMemoryRepresentation,
  SharedMemorySession,
  SharedMemorySessionReference,
  SharedMemorySourceItem,
  SharedMemorySourcePage
} from "./collaboration-contract.js";

export {
  buildConversationApprovalDisplay,
  buildConversationToolDisplay,
  conversationToolKindAndLabel,
  type ConversationApprovalDisplay,
  type ConversationToolDisplay
} from "./conversation-display.js";

export {
  fetchWithTimeout,
  fetchBoundedJsonObject,
  readBoundedJsonObject,
  RemoteRequestTimeoutError,
  RemoteResponseLimitError,
  upstreamApiUrl
} from "./bounded-http.js";
export { isPrivateNetworkIpv4Address } from "./private-network.js";
export {
  API_DATA_ENCRYPTION_KEY_ENV,
  createByokEnvelopeEncryptionProvider,
  createCmekEnvelopeEncryptionProvider,
  createEnvelopeEncryptionProviderFromEnvironment,
  createHttpManagedKmsKeyring,
  createLocalTestKeyEnvelopeEncryptionProvider,
  createManagedKmsEnvelopeEncryptionProvider,
  createOwnerPrivateReplicaEnvelopeEncryptionProviderFromEnvironment,
  createTeamMemoryEnvelopeEncryptionProviderFromEnvironment,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  createUnsupportedEnvelopeEncryptionProvider,
  DATA_ENCRYPTION_KEY_ENV_ALIAS,
  decryptEnvelopeToUtf8,
  ENCRYPTED_PAYLOAD_ALGORITHM,
  ENCRYPTED_PAYLOAD_ENVELOPE_VERSION,
  ENCRYPTED_PAYLOAD_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_KMS_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_MANAGED_KMS_KEY_WRAP_ALGORITHM,
  ENCRYPTED_PAYLOAD_RSA_KEY_WRAP_ALGORITHM,
  envelopeEncryptionProviderModes,
  EnvelopeEncryptionError,
  generateRecipientKeyMaterial,
  InvalidEncryptedPayloadEnvelopeError,
  ManagedKmsProviderError,
  OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY_ENV,
  OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER_ENV,
  OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN_ENV,
  OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL_ENV,
  OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID_ENV,
  OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION_ENV,
  RECIPIENT_PUBLIC_KEY_PROVIDER_MODE,
  RECIPIENT_RSA_JWK_ALGORITHM,
  RECIPIENT_RSA_KEY_BITS,
  redactEnvelopeEncryptionProviderStatus,
  requireApiDataEncryptionKey,
  resolveApiDataEncryptionKeyFromEnv,
  RecipientKeyTransportError,
  toRecipientPublicKeyMaterial,
  UnsupportedEnvelopeEncryptionProviderError,
  validateEnvelopeEncryptionProviderEnvironment
} from "./envelope-encryption.js";
export {
  createEncryptedJsonPackage,
  decryptEncryptedJsonPackage,
  ENCRYPTED_PACKAGE_MANIFEST_VERSION,
  encryptedPackageObjectClasses
} from "./encrypted-package.js";
export {
  assertSecureHttpTransport,
  isLoopbackHostname
} from "./http-transport-security.js";
export {
  createDeviceBoundSourceSigner,
  createPlatformHostProofStore,
  deviceIdentitySchemaVersion,
  deviceIdentityStatePathFor,
  deviceProofFingerprint,
  hostProofReferenceFor,
  inspectDeviceIdentity,
  inspectDeviceIdentityAtKoedHome,
  reconcileDeviceIdentityDeployment,
  parseDeviceIdentityState,
  serializeHostProof
} from "./device-identity.js";
export type {
  DeviceBoundSourceSigner,
  DeviceIdentityHealth,
  DeviceIdentityInspection,
  DeviceIdentityState,
  HostProofReadResult,
  HostProofStore
} from "./device-identity.js";
export {
  highRiskActionGrantCommitment,
  highRiskActionGrantCommitmentHash
} from "./high-risk-action-grant-commitment.js";
export {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "./high-risk-action-grant-hash.js";
export type { HighRiskActionGrantHashDomain } from "./high-risk-action-grant-hash.js";
export {
  deriveLocalProjectId,
  hmacProjectValue,
  isPortableGitRemote,
  mergeGitRemoteAliases,
  normalizeGitRemoteUrl,
  normalizeProjectDisplayName,
  safeProjectMetadataForRemote
} from "./project-metadata.js";
export {
  clearCollaborationActionGrantCustodyForBackend,
  deleteCollaborationActionGrantCustody,
  markCollaborationActionGrantCustodyAmbiguous,
  readCollaborationActionGrantCustodyCommitmentHash,
  readCollaborationActionGrantCustodyStatus,
  resolveCollaborationActionGrantSecret,
  storeCollaborationActionGrantCustody,
  updateCollaborationActionGrantCustodyStatus
} from "./collaboration-action-grant-custody-store.js";
export {
  clearCollaborationPendingTeamSends,
  deleteCollaborationPendingSend,
  listCollaborationPendingSends,
  storeCollaborationPendingSend,
  updateCollaborationPendingSendState
} from "./collaboration-pending-send-store.js";
export {
  deleteLocalEdgeClientCredential,
  localEdgeClientCredentialReferenceFor,
  readLocalEdgeClientCredentialAuthorization,
  storeLocalEdgeClientCredential,
  verifyLocalEdgeClientCredentialAuthorization
} from "./local-edge-client-credential-custody.js";
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
} from "./upstream-desktop-credential-custody.js";
export {
  SHARED_MEMORY_AUTHORITY_ACTION,
  sharedMemoryConsentActionGrantBinding,
  sharedMemoryGrantManagementRequestHash,
  sharedMemoryGrantManagementScopeHash,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryFidelityActionGrantBinding,
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
  sharedMemoryShareActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding
} from "./shared-memory-action-grant.js";
export type {
  SharedMemoryActionGrantBinding,
  SharedMemoryRepresentation as SharedMemoryActionGrantRepresentation
} from "./shared-memory-action-grant.js";
export type {
  CollaborationActionGrantAccessInput,
  CollaborationActionGrantCustodyInput,
  CollaborationActionGrantMethod,
  CollaborationActionGrantOperationFamily,
  CollaborationActionGrantResolveInput,
  CollaborationActionGrantState,
  CollaborationActionGrantStatusRecord
} from "./collaboration-action-grant-custody-store.js";
export type {
  CollaborationPendingSendInput,
  CollaborationPendingSendRecord
} from "./collaboration-pending-send-store.js";
export type {
  DesktopLocalCredentialAuthorization,
  DesktopLocalCredentialInput,
  DesktopLocalCredentialOperationFamily
} from "./upstream-desktop-credential-custody.js";
export type {
  EncryptedPayloadEnvelope,
  EncryptedPayloadProvenance,
  EncryptedPayloadScope,
  EnvelopeEncryptionProviderStatus,
  EnvelopeEncryptionProvider,
  EnvelopeEncryptionProviderMode,
  EnvelopeEncryptionRootProviderMode,
  EncryptPayloadInput,
  EnvelopeEncryptionProviderEnvironmentOptions,
  EnvelopeEncryptionEnvironmentValidationOptions,
  HttpManagedKmsKeyringConfig,
  GenerateRecipientKeyMaterialInput,
  ManagedKmsKeyring,
  ManagedKmsUnwrapDekInput,
  ManagedKmsWrapDekInput,
  ManagedKmsWrappedDek,
  RecipientKeyMaterial,
  RecipientPublicJwk,
  RecipientPublicKeyMaterial,
  WrappedDataEncryptionKey
} from "./envelope-encryption.js";
export type {
  CreateEncryptedJsonPackageInput,
  EncryptedJsonPackage,
  EncryptedPackageManifest,
  EncryptedPackageObjectClass
} from "./encrypted-package.js";
export {
  PDS_PROTOCOL,
  PDS_CERTIFICATE_CLOCK_SKEW_MS,
  PDS_CERTIFICATE_MAX_LIFETIME_MS,
  assertEpochAdvance,
  certificateIsPdsValid,
  comparePdsCanonicalIds,
  decodePdsBase64url,
  createPdsAuthorizedKeyBundle,
  decryptPdsKeyBundleSecretSet,
  pdsEd25519PrivateKey,
  pdsEd25519PublicKey,
  pdsX25519PrivateKey,
  pdsX25519PublicKey,
  pdsFinalizedStatementHash,
  pdsFinalizedTwoStageRecordHash,
  pdsPublicKeyCommitment,
  pdsSha256,
  signPdsGroupDraft,
  signPdsGroupFinal,
  signPdsTwoStageDraft,
  signPdsRecord,
  signPdsTwoStageFinal,
  validatePdsGroupStatement,
  validatePdsTombstone,
  validatePdsTombstoneAck,
  validatePdsPackageAck,
  validatePdsConflictResolution,
  validatePdsKeyBundle,
  validatePdsEpochAck,
  validatePdsKeyBundleAck,
  validatePdsKeyBundleMetadata,
  verifyPdsEnrollmentProof
} from "./personal-device-sync.js";
export type {
  PdsConflictResolution,
  PdsGroupSecretSet,
  PdsGroupStatement,
  PdsKeyBundleRecipient,
  PdsSignature,
  PdsTombstone
} from "./personal-device-sync.js";
export {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  parsePdsUint64,
  pdsUint64be
} from "./personal-device-sync-jcs.js";
export {
  PDS_RELAY_REQUEST_CLOCK_SKEW_MS,
  PDS_RELAY_REQUEST_NONCE_BYTES,
  canonicalizePdsRelayRequestTarget,
  parsePdsRelayRequestProof,
  pdsRelayBodyDigest,
  pdsRelayNonceDigest,
  pdsRelayRequestNonceExpiresAt,
  pdsRelayRequestSigningBytes,
  verifyPdsRelayRequestProof
} from "./personal-device-sync-relay.js";
export type { PdsRelayRequestProof } from "./personal-device-sync-relay.js";
export { PdsRelayClient } from "./personal-device-sync-relay-client.js";
export type {
  PdsRelayClientIdentity,
  PdsRelayClientOptions
} from "./personal-device-sync-relay-client.js";
export {
  PDS_SESSION_PACKAGE_VERSION,
  PDS_SESSION_PACKAGE_MAX_BYTES,
  PDS_SESSION_PACKAGE_MAX_CHUNK_BYTES,
  PDS_SESSION_PACKAGE_MAX_CHUNKS,
  PDS_SESSION_PACKAGE_MAX_CONTROL_BYTES,
  PDS_SESSION_PACKAGE_MAX_JSON_BYTES,
  PDS_SESSION_PACKAGE_MAX_RECIPIENTS,
  createPdsEncryptedPayloadPackage,
  createPdsSessionPackageRuntimeContext,
  createPdsSessionManifest,
  createPdsSessionPackage,
  decryptPdsEncryptedPayloadPackage,
  parsePdsSessionManifestJson,
  parsePdsSessionPackageJson,
  pdsDeletionFloorToken,
  pdsLogicalMemoryId,
  pdsProjectAliasToken,
  pdsSessionPackageDigest,
  pdsSourceFingerprint,
  rewrapPdsSessionPackage,
  validatePdsRelayTransport,
  validatePdsSessionPackageChunk,
  verifyAndDecryptPdsSessionPackage
} from "./personal-device-session-package.js";
export type {
  CreatePdsSessionManifestInput,
  CreatePdsEncryptedPayloadPackageInput,
  CreatePdsSessionPackageInput,
  DecryptPdsEncryptedPayloadPackageResult,
  CreatePdsSessionPackageRuntimeContextInput,
  PdsClosedSessionMetadata,
  PdsConversationSourceItem,
  PdsProjectAliasManifest,
  PdsRetainedSessionPackage,
  PdsSessionManifest,
  PdsSessionPackage,
  PdsSessionPackageChunk,
  PdsSessionPackageReplayEntry,
  PdsSessionPackageReplayResult,
  PdsSessionPackageHeader,
  PdsRelayTransportRuntime,
  PdsSessionPackageRuntimeContext,
  PdsSessionRecipient,
  PdsSessionRecipientEnvelope,
  PdsRawSourceRecord,
  VerifyPdsSessionPackageInput
} from "./personal-device-session-package.js";
export {
  PDS_ARTIFACT_MAX_ITEMS,
  PDS_ARTIFACT_MAX_JSON_BYTES,
  PDS_ARTIFACT_PROTOCOL,
  PDS_ARTIFACT_SCHEMA_VERSION,
  PDS_PERSONAL_REPLICATION_REGISTRY,
  createPdsArtifactRecord,
  parsePdsArtifactRecordJson,
  pdsArtifactClasses,
  pdsArtifactCompatibilityHash,
  pdsArtifactPayloadHash,
  pdsPortableEmbeddingSourceHash,
  pdsPortableEmbeddingVectorHash,
  pdsPortableLcmNodeContentHash,
  pdsPortableLcmNodeId,
  pdsPortableMemoryEventContentHash,
  pdsPortableMemoryEmbeddingId,
  pdsPortableMemoryEmbeddingWorkIdentity,
  pdsPortableMemoryEventId,
  validatePdsArtifactRecord,
  verifyPdsArtifactRecord
} from "./personal-device-artifact.js";
export type {
  PdsArtifactClass,
  PdsArtifactCompatibilityContract,
  PdsArtifactManifest,
  PdsArtifactPayload,
  PdsArtifactRecord,
  PdsEmbeddingContractV1,
  PdsLcmNodeContractV1,
  PdsMemoryEventContractV1,
  PdsPortableLcmNodeV1,
  PdsPortableMemoryEmbeddingV1,
  PdsPortableMemoryEventV1,
  PdsReplicationClassification
} from "./personal-device-artifact.js";
export {
  CAPTURED_SESSION_SYNC_FORMAT,
  CAPTURED_SESSION_SYNC_FORMAT_VERSION,
  CAPTURED_SESSION_SYNC_MAX_CHANGES,
  CAPTURED_SESSION_SYNC_MAX_CHUNK_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CHUNKS,
  CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
  CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES,
  CAPTURED_SESSION_SYNC_MAX_CONTRIBUTORS_PER_EVENT,
  CAPTURED_SESSION_SYNC_MAX_PACKAGE_BYTES,
  CAPTURED_SESSION_SYNC_POLICY_VERSION,
  capturedSessionSyncUploadPackageManifestSchema,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  crossIdentitySyncPackageRequestHash,
  crossIdentitySyncSummaryNodeRevisionHash,
  isCapturedSessionSyncChunkV1,
  isCapturedSessionSyncPackageV1
} from "./cross-identity-sync.js";
export {
  koedLocalWorkSignalPath,
  requestKoedLocalWork,
  watchKoedLocalWork
} from "./local-work-signal.js";
export type { KoedLocalWorkSignal } from "./local-work-signal.js";
export {
  LCM_LEXICAL_ANCHOR_MAX_COUNT,
  LCM_LEXICAL_ANCHOR_MAX_LENGTH
} from "./lcm-summary-limits.js";
export {
  extractSharedMemorySemanticClassificationFields,
  reconstructSharedMemorySemanticSanitizedItems,
  sharedMemoryRepresentations,
  SharedMemoryConflictError,
  SharedMemorySourceItemRejectedError,
  validateSharedMemoryCanonicalSourceItem,
  validateSharedMemorySemanticSanitizedReconstruction,
  type SharedMemoryCanonicalSourceItemDto,
  type SharedMemorySemanticClassificationField,
  type SharedMemorySemanticMaskedField,
  type SharedMemorySourceItemInput,
  type SharedMemorySourceItemType
} from "./shared-memory-semantic-contract.js";
export type {
  CapturedSessionSyncChangeOperation,
  CapturedSessionSyncChangeV1,
  CapturedSessionSyncChunkV1,
  CapturedSessionSyncContributorV1,
  CapturedSessionSyncEventV1,
  CapturedSessionSyncPackageV1,
  CapturedSessionSyncSummaryNodeV1,
  CapturedSessionSyncUploadPackageManifest
} from "./cross-identity-sync.js";
export {
  SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
  SHARED_SOURCE_PREVIEW_SCHEMA_VERSION,
  sharedMemoryGrantScopedSourceId,
  sharedSourceArtifactHash,
  sharedSourceArtifactId,
  sharedSourcePreviewHash,
  sharedSourcePreviewId
} from "./shared-source-artifact.js";
export type {
  SharedSourceArtifactBindingV1,
  SharedSourceArtifactItemType,
  SharedSourceArtifactItemV1,
  SharedSourceArtifactManifestEntryV1,
  SharedSourceArtifactPolicyBindingV1,
  SharedSourceArtifactReference,
  SharedSourceArtifactRepresentation,
  SharedSourceArtifactSyncBindingV1,
  SharedSourceArtifactV1,
  SharedSourcePreviewReference,
  SharedSourcePreviewV1
} from "./shared-source-artifact.js";
export type {
  NormalizedGitRemote,
  ProjectMetadataV1,
  ProjectPackageMetadata
} from "./project-metadata.js";
export type {
  LocalEdgeClientCredentialAuthorization,
  LocalEdgeClientCredentialInput
} from "./local-edge-client-credential-custody.js";
export type {
  EnrollmentCredentialCustodyInput,
  EnrollmentCredentialCustodyResult,
  UpstreamCredentialSecretInput,
  UpstreamCredentialSecretStoreDeps
} from "./upstream-desktop-credential-custody.js";

export type HealthStatus = "ok" | "degraded" | "error";

export const memoryEmbedQueueName = "memory-embed";
export const lcmCompactQueueName = "lcm-compact";
export const lcmEmbedQueueName = "lcm-embed";

export const RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES = 256 * 1024;
export const RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT = 64;
export const RAW_CONVERSATION_LOGICAL_ITEM_MAX_BYTES =
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES *
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT;

export const CURATED_MEMORY_REVIEW_MAX_EVIDENCE = 12;

export const rawConversationTransportChunkGroupId = (input: {
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  logicalSourceId: string;
  sourceItemHash: string;
  transportChunkCount: number;
  transportChunkEncoding: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        ...input
      })
    )
    .digest("hex");

export const canonicalConversationItemKey = (input: {
  provider: string;
  externalThreadId: string;
  externalTurnId?: string;
  stableItemId: string;
  component: string;
}): string =>
  `conversation-item:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 3,
        provider: input.provider,
        externalThreadId: input.externalThreadId,
        externalTurnId: input.externalTurnId ?? null,
        stableItemId: input.stableItemId,
        component: input.component
      })
    )
    .digest("hex")}`;

export const codexCanonicalConversationItemKey = (
  input: Omit<Parameters<typeof canonicalConversationItemKey>[0], "provider">
): string => canonicalConversationItemKey({ provider: "codex", ...input });

export const workerQueueNames = [
  memoryEmbedQueueName,
  lcmCompactQueueName,
  lcmEmbedQueueName
] as const;

export type WorkerQueueName = (typeof workerQueueNames)[number];

export type KoedQueueBackend = "bullmq" | "local";

export const historicalImportSourceTransport = "historical_import";

export const koedWorkClasses = [
  "interactive_recall_question",
  "live_capture_projection",
  "normal_embedding_lcm",
  "historical_import_backfill"
] as const;

export type KoedWorkClass = (typeof koedWorkClasses)[number];

const workClassPriorities: Record<KoedWorkClass, number> = {
  interactive_recall_question: 1,
  live_capture_projection: 5,
  normal_embedding_lcm: 10,
  historical_import_backfill: 20
};

export const workClassPriority = (workClass: KoedWorkClass): number =>
  workClassPriorities[workClass];

export const defaultKoedQueuePriority =
  workClassPriorities.normal_embedding_lcm;

export const resolveKoedWorkClass = (
  value: unknown,
  fallback: KoedWorkClass = "normal_embedding_lcm"
): KoedWorkClass =>
  typeof value === "string" && koedWorkClasses.includes(value as KoedWorkClass)
    ? (value as KoedWorkClass)
    : fallback;

export const projectionWorkClassForSourceTransport = (
  sourceTransport: string
): KoedWorkClass =>
  sourceTransport === historicalImportSourceTransport
    ? "historical_import_backfill"
    : "live_capture_projection";

const koedQueueBackends = new Set<KoedQueueBackend>(["bullmq", "local"]);

export const resolveKoedQueueBackend = (
  value: string | undefined,
  fallback: KoedQueueBackend = "bullmq"
): KoedQueueBackend => {
  const normalized = value?.trim();
  return normalized && koedQueueBackends.has(normalized as KoedQueueBackend)
    ? (normalized as KoedQueueBackend)
    : fallback;
};

export interface KoedJobHandle {
  id: string | number | undefined;
}

export interface KoedJobEnqueueOptions {
  /** Lower values run first in both BullMQ and local queue backends. */
  priority?: number;
  jobId?: string;
  attempts?: number;
  backoff?: {
    type: string;
    delay: number;
  };
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

export interface KoedJobQueue<TJobData = unknown> {
  add(
    name: string,
    data: TJobData,
    options?: KoedJobEnqueueOptions
  ): Promise<KoedJobHandle>;
  getJobCounts(...statuses: string[]): Promise<Record<string, number>>;
  getOldestPendingAgeMs?(): Promise<number | null>;
  close(): Promise<void>;
}

const queueJobIdPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 180);

export const embeddingDispatchKey = (
  modelKey: string,
  dimensions: number
): string => `${modelKey}-${dimensions}`;

export const embeddingQueueJobId = (
  dispatchKey: string,
  sourceType: string,
  sourceId: string
): string =>
  `embed-${queueJobIdPart(dispatchKey)}-${queueJobIdPart(sourceType)}-${queueJobIdPart(sourceId)}`;

export const lcmCompactionQueueJobId = (
  userId: string,
  visibility: string,
  dispatchKey: string
): string =>
  `compact-${queueJobIdPart(userId)}-${queueJobIdPart(visibility)}-${queueJobIdPart(dispatchKey)}`;

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export const createHealth = (
  service: string,
  status: HealthStatus = "ok",
  details?: Record<string, unknown>
): ServiceHealth => ({
  service,
  status,
  checkedAt: new Date().toISOString(),
  ...(details ? { details } : {})
});

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const requireEnv = (
  names: string[],
  environment: NodeJS.ProcessEnv = process.env
): void => {
  const missing = names.filter((name) => {
    const value = environment[name];
    return (
      value === undefined ||
      value.trim() === "" ||
      value.trim().startsWith("replace_with_generated")
    );
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`
    );
  }
};

const truthyConfigValues = new Set(["1", "true", "yes", "on"]);

export const configFlagEnabled = (value: string | undefined): boolean =>
  value ? truthyConfigValues.has(value.trim().toLowerCase()) : false;

const NUL_CHARACTER = "\u0000";
export const NUL_DISPLAY_REPLACEMENT = "\uFFFD";

export interface StorageSanitizationCounts {
  nulCharacters: number;
  malformedUtf16: number;
}

export interface StorageSanitizationResult {
  value: unknown;
  replacementCount: number;
  counts: StorageSanitizationCounts;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value as object);
  return prototype === Object.prototype || prototype === null;
};

const emptyStorageSanitizationCounts = (): StorageSanitizationCounts => ({
  nulCharacters: 0,
  malformedUtf16: 0
});

const addStorageSanitizationCounts = (
  target: StorageSanitizationCounts,
  source: StorageSanitizationCounts
): void => {
  target.nulCharacters += source.nulCharacters;
  target.malformedUtf16 += source.malformedUtf16;
};

const totalStorageSanitizationCount = (
  counts: StorageSanitizationCounts
): number => counts.nulCharacters + counts.malformedUtf16;

export const combineStorageSanitizationCounts = (
  ...results: Array<{ counts: StorageSanitizationCounts }>
): StorageSanitizationCounts => {
  const counts = emptyStorageSanitizationCounts();
  for (const result of results) {
    addStorageSanitizationCounts(counts, result.counts);
  }
  return counts;
};

const countMalformedUtf16CodeUnits = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
      } else {
        count += 1;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      count += 1;
    }
  }
  return count;
};

const fallbackToWellFormed = (value: string): string => {
  let wellFormed = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        wellFormed += value[index] ?? "";
        wellFormed += value[index + 1] ?? "";
        index += 1;
      } else {
        wellFormed += NUL_DISPLAY_REPLACEMENT;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      wellFormed += NUL_DISPLAY_REPLACEMENT;
    } else {
      wellFormed += value[index] ?? "";
    }
  }
  return wellFormed;
};

const toWellFormedStorageString = (value: string): string => {
  const nativeToWellFormed = (value as string & { toWellFormed?: () => string })
    .toWellFormed;
  return typeof nativeToWellFormed === "function"
    ? nativeToWellFormed.call(value)
    : fallbackToWellFormed(value);
};

export const sanitizeForPostgresStorage = (
  value: unknown
): StorageSanitizationResult => {
  if (typeof value === "string") {
    const nulCharacters = value.split(NUL_CHARACTER).length - 1;
    const withoutNul =
      nulCharacters > 0
        ? value.replaceAll(NUL_CHARACTER, NUL_DISPLAY_REPLACEMENT)
        : value;
    const malformedUtf16 = countMalformedUtf16CodeUnits(withoutNul);
    const sanitized =
      malformedUtf16 > 0 ? toWellFormedStorageString(withoutNul) : withoutNul;
    const counts = { nulCharacters, malformedUtf16 };
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  if (Array.isArray(value)) {
    const counts = emptyStorageSanitizationCounts();
    const sanitized = value.map((item) => {
      const result = sanitizeForPostgresStorage(item);
      addStorageSanitizationCounts(counts, result.counts);
      return result.value;
    });
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  if (isPlainRecord(value)) {
    const counts = emptyStorageSanitizationCounts();
    const sanitized: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const sanitizedKey = sanitizeForPostgresStorage(key);
      const sanitizedField = sanitizeForPostgresStorage(field);
      addStorageSanitizationCounts(counts, sanitizedKey.counts);
      addStorageSanitizationCounts(counts, sanitizedField.counts);
      sanitized[String(sanitizedKey.value)] = sanitizedField.value;
    }
    return {
      value: sanitized,
      replacementCount: totalStorageSanitizationCount(counts),
      counts
    };
  }

  const counts = emptyStorageSanitizationCounts();
  return { value, replacementCount: 0, counts };
};

export const metadataWithStorageSanitization = (
  metadata: Record<string, unknown>,
  counts: StorageSanitizationCounts
): Record<string, unknown> => {
  if (totalStorageSanitizationCount(counts) === 0) {
    return metadata;
  }
  const existingKoed = isPlainRecord(metadata.koedSanitization)
    ? metadata.koedSanitization
    : {};
  const sanitization: Record<string, unknown> = { ...existingKoed };
  if (counts.nulCharacters > 0) {
    sanitization.nulCharacters = {
      replacement: "U+FFFD",
      replacementCount: counts.nulCharacters
    };
  }
  if (counts.malformedUtf16 > 0) {
    sanitization.malformedUtf16 = {
      replacement: "U+FFFD",
      replacementCount: counts.malformedUtf16
    };
  }
  return {
    ...metadata,
    koedSanitization: sanitization
  };
};

export interface SupportedEmbeddingModelConfig {
  key: string;
  dimensions: number;
  artifact: string;
  artifactRevision: string;
  defaultArtifactSha256: string;
  tokenizer: string;
  tokenizerRevision: string;
  inputTransform: string;
  pooling: string;
  normalization: string;
}

/** Versioned trusted Team evidence-to-embedding composition contract. */
export const TEAM_SEMANTIC_COMPOSITION_VERSION =
  "team-semantic-v1:text-v1:mean-pool:l2-normalized" as const;

export {
  MEMORY_RETRIEVAL_EXACT_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_COUNT,
  MEMORY_RETRIEVAL_HINT_MAX_LENGTH,
  MEMORY_RETRIEVAL_SEMANTIC_HINT_MAX_COUNT,
  memoryRetrievalExactHintsSchema,
  memoryRetrievalHintSchema
} from "./memory-retrieval-hints.js";

export const teamSemanticEmbeddingGeneration = (input: {
  model: string;
  tokenizer: string;
  inputTransform: string;
  pooling: string;
  normalization: string;
}): string =>
  [
    TEAM_SEMANTIC_COMPOSITION_VERSION,
    `model=${input.model}`,
    `tokenizer=${input.tokenizer}`,
    `input=${input.inputTransform}`,
    `service-pooling=${input.pooling}`,
    `service-normalization=${input.normalization}`
  ].join("|");

export interface SupportedRerankerModelConfig {
  key: string;
  model: string;
}

export const DEFAULT_EMBEDDING_MODEL_KEY = "qwen3-0.6b";
export const DEFAULT_EMBEDDING_QUERY_INSTRUCTION =
  "Given a question about captured AI-client memory, retrieve relevant memory events, conversation items, and summaries that answer the question.";
export const EMBEDDING_RETRIEVAL_QUERY_TRANSFORM = "qwen3-retrieval-query-v1";
export const EMBEDDING_RETRIEVAL_DOCUMENT_TRANSFORM =
  "qwen3-retrieval-document-v1";

export const formatEmbeddingRetrievalQuery = (
  query: string,
  options: { instruction?: string; enabled?: boolean } = {}
): string =>
  options.enabled === false
    ? query
    : `Instruct: ${options.instruction?.trim() || DEFAULT_EMBEDDING_QUERY_INSTRUCTION}\nQuery: ${query}`;

export const formatEmbeddingRetrievalDocument = (document: string): string =>
  document;
export const DEFAULT_RERANKER_MODEL_KEY = "qwen3-reranker-0.6b";

export const SUPPORTED_EMBEDDING_MODELS: Record<
  string,
  SupportedEmbeddingModelConfig
> = {
  "qwen3-0.6b": {
    key: "qwen3-0.6b",
    dimensions: 1024,
    artifact:
      "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
    artifactRevision: "main",
    defaultArtifactSha256:
      "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    tokenizer: "qwen3-embedding-0.6b-gguf",
    tokenizerRevision:
      "embedded-in-artifact:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    inputTransform: "qwen3-retrieval-document-v1",
    pooling: "last",
    normalization: "l2"
  }
};

export const SUPPORTED_RERANKER_MODELS: Record<
  string,
  SupportedRerankerModelConfig
> = {
  "qwen3-reranker-0.6b": {
    key: "qwen3-reranker-0.6b",
    model:
      "Voodisss/Qwen3-Reranker-0.6B-GGUF-llama_cpp:Qwen3-Reranker-0.6B-Q4_K_M.gguf"
  }
};

export const resolveSupportedEmbeddingModelConfig = (
  key: string | undefined = DEFAULT_EMBEDDING_MODEL_KEY
): SupportedEmbeddingModelConfig => {
  const normalized = key.trim() || DEFAULT_EMBEDDING_MODEL_KEY;
  const config = SUPPORTED_EMBEDDING_MODELS[normalized];
  if (!config) {
    throw new Error(
      `Unsupported embedding model key: ${normalized}. Supported model keys: ${Object.keys(
        SUPPORTED_EMBEDDING_MODELS
      )
        .sort()
        .join(", ")}`
    );
  }
  return config;
};

export const resolveSupportedRerankerModelConfig = (
  key: string | undefined
): SupportedRerankerModelConfig | null => {
  const normalized = key?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const config = SUPPORTED_RERANKER_MODELS[normalized];
  if (!config) {
    throw new Error(
      `Unsupported reranker model key: ${normalized}. Supported model keys: ${Object.keys(
        SUPPORTED_RERANKER_MODELS
      )
        .sort()
        .join(", ")}`
    );
  }
  return config;
};

export const resolveRerankerKeyFromEnv = (environment: {
  EMBEDDING_RERANKER_KEY?: string;
  RERANKER_KEY?: string;
}): string | undefined =>
  Object.prototype.hasOwnProperty.call(environment, "RERANKER_KEY")
    ? environment.RERANKER_KEY
    : environment.EMBEDDING_RERANKER_KEY;
