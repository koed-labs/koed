import { privacyClassifierHash } from "./privacy-filter-contract.js";

export const PINNED_PRIVACY_MODEL_ID = "openai/privacy-filter";
export const PINNED_PRIVACY_MODEL_REVISION =
  "7ffa9a043d54d1be65afb281eddf0ffbe629385b";
export const PINNED_PRIVACY_Q4_ONNX_SHA256 =
  "8f7dee8b46d096f052b359375dfba5d983cc4d18c44a783bf548615c472f8dea";
export const PINNED_PRIVACY_Q4_ONNX_SIZE = 160_219;
export const PINNED_PRIVACY_Q4_DATA_SHA256 =
  "f30998e28c71c5374cc7e8b7de8f0f83e981592c0c2d652d2ad4928454dbb496";
export const PINNED_PRIVACY_Q4_DATA_SIZE = 917_120_144;
export const PINNED_PRIVACY_TOKENIZER_SHA256 =
  "0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3";
export const PINNED_PRIVACY_CALIBRATION_SHA256 =
  "bbc8611ef08a55ed72d64856cbbbb9a91db8dfa881f0a92e2afbad6e4bbc775a";
export const PINNED_PRIVACY_CONFIG_SHA256 =
  "b2b26a4a4a000639ad30b0c264adbefe365bdb567fbd7bb27303b8c438375bd1";
export const PINNED_PRIVACY_TOKENIZER_CONFIG_SHA256 =
  "6c14af9ce1a284d3c3c5146b26efe4cd589c68e1dd4e9d94455606ec911ba774";
export const PINNED_PRIVACY_ARTIFACT_SHA256 =
  "5c2539e0f69a6cc737b054f1897b13b41767b22bbcf8efa6c1eef236cd105c5f";
export const PINNED_PRIVACY_DECODER_SHA256 =
  "4a78599a9073d78aaa383b0cf696904e76566fc82fda20811960e883d866edb1";
export const PINNED_PRIVACY_DETERMINISTIC_DETECTOR_VERSION =
  "koed-secret-detector-v1";

export const PINNED_PRIVACY_MODEL_FILES = Object.freeze([
  {
    path: "onnx/model_q4.onnx",
    sha256: PINNED_PRIVACY_Q4_ONNX_SHA256,
    size: PINNED_PRIVACY_Q4_ONNX_SIZE
  },
  {
    path: "onnx/model_q4.onnx_data",
    sha256: PINNED_PRIVACY_Q4_DATA_SHA256,
    size: PINNED_PRIVACY_Q4_DATA_SIZE
  },
  { path: "tokenizer.json", sha256: PINNED_PRIVACY_TOKENIZER_SHA256 },
  {
    path: "viterbi_calibration.json",
    sha256: PINNED_PRIVACY_CALIBRATION_SHA256
  },
  { path: "config.json", sha256: PINNED_PRIVACY_CONFIG_SHA256 },
  {
    path: "tokenizer_config.json",
    sha256: PINNED_PRIVACY_TOKENIZER_CONFIG_SHA256
  }
] as const);

export const PINNED_PRIVACY_CLASSIFIER_GENERATION = Object.freeze({
  version: 1,
  modelKey: PINNED_PRIVACY_MODEL_ID,
  modelRevision: PINNED_PRIVACY_MODEL_REVISION,
  artifactSha256: PINNED_PRIVACY_ARTIFACT_SHA256,
  tokenizerSha256: PINNED_PRIVACY_TOKENIZER_SHA256,
  decoderSha256: PINNED_PRIVACY_DECODER_SHA256,
  calibrationSha256: PINNED_PRIVACY_CALIBRATION_SHA256,
  deterministicDetectorVersion: PINNED_PRIVACY_DETERMINISTIC_DETECTOR_VERSION
});

export const PINNED_PRIVACY_CLASSIFIER_HASH = privacyClassifierHash(
  PINNED_PRIVACY_CLASSIFIER_GENERATION
);
