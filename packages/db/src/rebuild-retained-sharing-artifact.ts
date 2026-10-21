import {
  sharedMemoryCeilingAuthorizes,
  sharedSourceArtifactHash,
  sharedSourceArtifactId,
  SharedMemoryConflictError,
  type SharedSourceArtifactV1
} from "@koed/shared";

/** Rebind policy metadata without selecting or synthesizing any source content.
 * Source, revision, body, manifest and original sync provenance stay identical. */
export const rebuildRetainedSharingArtifact = (input: {
  original: SharedSourceArtifactV1;
  binding: Omit<
    SharedSourceArtifactV1["binding"],
    "sourceRevision" | "sourceHash"
  >;
  policies: SharedSourceArtifactV1["policies"];
  selection: SharedSourceArtifactV1["selection"];
}): SharedSourceArtifactV1 => {
  const { original, selection } = input;
  if (
    sharedSourceArtifactHash(original) !== original.artifactHash ||
    sharedSourceArtifactId(original.artifactHash) !== original.artifactId ||
    original.selection.mode !== "continuous" ||
    selection.mode !== "continuous" ||
    !sharedMemoryCeilingAuthorizes(
      original.selection.maximumFidelity,
      selection.maximumFidelity
    ) ||
    (selection.includeCuratedMemory &&
      !original.selection.includeCuratedMemory) ||
    !sharedMemoryCeilingAuthorizes(
      selection.maximumFidelity,
      original.representation,
      selection.includeCuratedMemory
    ) ||
    !selection.sourceCapabilities.includes(original.representation) ||
    !selection.sourceCapabilities.includes(
      selection.activationRepresentation
    ) ||
    selection.sourceCapabilities.some(
      (representation) =>
        !original.selection.sourceCapabilities.includes(representation) ||
        !sharedMemoryCeilingAuthorizes(
          selection.maximumFidelity,
          representation,
          selection.includeCuratedMemory
        )
    )
  )
    throw new SharedMemoryConflictError(
      "Historical preparation cannot expand its original source scope"
    );
  const body = {
    ...original,
    artifactId: "",
    binding: {
      ...input.binding,
      sourceRevision: original.binding.sourceRevision,
      sourceHash: original.binding.sourceHash
    },
    policies: { ...input.policies },
    selection: {
      ...selection,
      sourceCapabilities: [...selection.sourceCapabilities]
    }
  };
  const artifactHash = sharedSourceArtifactHash(body);
  return {
    ...body,
    artifactId: sharedSourceArtifactId(artifactHash),
    artifactHash
  };
};
