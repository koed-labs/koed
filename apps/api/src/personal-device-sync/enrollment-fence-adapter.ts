import type { EnrollmentFenceIpcAdapter } from "@koed-labs/shared/enrollment-fence-ipc";
import { EnrollmentFence } from "./enrollment-fence.js";
import {
  recheckOwnerBinding,
  type OwnerBinding,
  type OwnerBindingOptions
} from "./owner-binding.js";

const MAX_ENDPOINT_EPOCHS = 100;
const MAX_PENDING_ADMISSIONS = 16;

/**
 * Unwired endpoint scope only. Activation is blocked until HTTP fence control
 * routes cannot create or mutate epochs outside this endpoint's authority.
 * Callers must supply the route's fence and a trusted channel. Before assessing
 * all-epoch drain, close admission, await it, and account for every creation
 * outcome; lost outcomes and evicted state remain uncertain, never drained.
 */
export function createEnrollmentFenceAdapter(
  fence: EnrollmentFence,
  binding: OwnerBinding,
  options: OwnerBindingOptions,
  epochLimit = MAX_ENDPOINT_EPOCHS
) {
  if (
    !Number.isSafeInteger(epochLimit) ||
    epochLimit < 1 ||
    epochLimit > MAX_ENDPOINT_EPOCHS
  )
    throw new Error("Invalid enrollment fence adapter epoch limit");
  const owner = Object.freeze({ ...binding });
  const epochs = new Set<string>();
  const admissions = new Set<Promise<unknown>>();
  let closed = false;
  const deny = () => new Error("Enrollment fence adapter denied or uncertain");
  const eligible = async () => {
    if (!(await recheckOwnerBinding(options, owner))) throw deny();
  };
  const registration = (ids: { instanceId: string; epochId: string }) => {
    if (ids.instanceId !== fence.instanceId || !epochs.has(ids.epochId))
      throw deny();
    return { ...ids, owner: owner.owner };
  };
  const guard = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch {
      throw deny();
    }
  };
  const admit = <T>(action: () => Promise<T>): Promise<T> => {
    if (closed || admissions.size >= MAX_PENDING_ADMISSIONS)
      return Promise.reject(deny());
    // Track before any eligibility callback can reentrantly close admission.
    const pending = Promise.resolve().then(() => guard(action));
    admissions.add(pending);
    return pending.finally(() => admissions.delete(pending));
  };
  return {
    instanceId: fence.instanceId,
    closeAdmission: async () => {
      closed = true;
      await Promise.allSettled([...admissions]);
    },
    createEpoch: () =>
      admit(async () => {
        if (epochs.size >= epochLimit) throw deny();
        await eligible();
        if (closed || epochs.size >= epochLimit) throw deny();
        const epochId = fence.createEpoch(owner.owner);
        epochs.add(epochId);
        return epochId;
      }),
    register: (ids) =>
      admit(async () => {
        const request = registration(ids);
        await eligible();
        if (closed) throw deny();
        return fence.register(request);
      }),
    fenceEpoch: (ids) =>
      guard(() => fence.fenceEpochAndDrain(registration(ids))),
    fenceOperation: (ids) =>
      guard(() =>
        fence.fenceAndDrain({
          ...registration(ids),
          operationId: ids.operationId
        })
      )
  } satisfies EnrollmentFenceIpcAdapter & { closeAdmission(): Promise<void> };
}
