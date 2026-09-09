export const classificationSignature = (classification) => ({
  classifier: classification.classifier,
  spans: classification.fields?.[0]?.spans?.map((span) => ({
    start: span.start,
    end: span.end,
    label: span.label
  }))
});

// The idle timer may expire between the completed request and the status read.
// Provider identity and classifier parity prove reload without requiring residency.
export const assertPrivacyReload = ({
  provider,
  status,
  classification,
  initialSignature
}) => {
  if (status.activeProvider !== provider) {
    throw new Error(
      `Packaged Privacy reload changed provider: ${JSON.stringify(status)}`
    );
  }
  if (
    JSON.stringify(classificationSignature(classification)) !==
    JSON.stringify(initialSignature)
  ) {
    throw new Error(
      "Packaged Privacy classification changed after idle reload."
    );
  }
};
