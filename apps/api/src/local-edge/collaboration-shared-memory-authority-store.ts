import {
  createCollaborationSharedMemoryAuthorityStore as createDbAuthorityStore,
  type CollaborationSharedMemoryAuthorityBindingRepository,
  type CollaborationSharedMemoryAuthorityStoreOptions,
  type DbPool
} from "@koed/db";

import type { CollaborationSharedMemoryAuthorityStore } from "./collaboration-shared-memory-control.js";

export type PostgresCollaborationSharedMemoryAuthorityStore =
  CollaborationSharedMemoryAuthorityStore &
    CollaborationSharedMemoryAuthorityBindingRepository;

/**
 * Creates the durable local authority store consumed by Shared Memory control.
 * Enrollment and sync integrations use the returned binding methods; renderer
 * commands receive only the narrower control interface.
 */
export const createPostgresCollaborationSharedMemoryAuthorityStore = (
  pool: DbPool,
  options: CollaborationSharedMemoryAuthorityStoreOptions
): PostgresCollaborationSharedMemoryAuthorityStore => {
  const repository = createDbAuthorityStore(pool, options);
  const controlStore: CollaborationSharedMemoryAuthorityStore = repository;
  return Object.assign(controlStore, {
    bindEnrollment: repository.bindEnrollment,
    revokeEnrollment: repository.revokeEnrollment,
    revokeBackendEnrollments: repository.revokeBackendEnrollments,
    bindCompanionSession: repository.bindCompanionSession,
    persistPendingShareSourceWork: repository.persistPendingShareSourceWork,
    claimPendingShareSourceWork: repository.claimPendingShareSourceWork,
    finishPendingShareSourceWork: repository.finishPendingShareSourceWork
  });
};
