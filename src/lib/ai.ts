import { AI_FEATURE_OPTIONS, AI_PROVIDER_FAMILY_OPTIONS } from "./constants";
import type {
  AiCapability,
  AiCapabilityBindingRecord,
  AiFeatureKey,
  AiFeatureSettings,
  AiManagedCapability,
  AiProviderFamily,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSuggestionFeatureType,
  AiSettingsSnapshot,
} from "./types";

export function providerDefaults(providerFamily: AiProviderFamily) {
  const option = AI_PROVIDER_FAMILY_OPTIONS.find((item) => item.value === providerFamily);
  return option
    ? { baseUrl: option.baseUrl, defaultModel: option.defaultModel }
    : { baseUrl: "", defaultModel: "" };
}

export function createAiProfileDraft(
  providerFamily: AiProviderFamily = "openai_compatible",
): AiProviderProfileUpsertInput {
  const defaults = providerDefaults(providerFamily);
  return {
    name: "",
    providerFamily,
    baseUrl: defaults.baseUrl,
    apiKey: "",
    defaultModel: defaults.defaultModel,
    supportsText: true,
    supportsImage: providerFamily !== "anthropic_compatible",
    supportsFile: false,
    enabled: true,
  };
}

export function defaultAiFeatureSettings(): AiFeatureSettings {
  return {
    masterEnabled: true,
    capabilities: {
      assistant: true,
      summary: true,
      suggestion_generation: true,
    },
    features: {
      "summary.activity_summary": true,
      "summary.project_brief": true,
      "summary.daily_brief": true,
      "suggestion_generation.conclusion": true,
      "suggestion_generation.todo": true,
    },
  };
}

export function aiFeatureCapability(feature: AiFeatureKey): AiManagedCapability {
  return (
    AI_FEATURE_OPTIONS.find((option) => option.value === feature)?.capability ??
    (feature.startsWith("summary.") ? "summary" : "suggestion_generation")
  );
}

export function featureSettingsFromSnapshot(snapshot?: AiSettingsSnapshot) {
  return snapshot?.featureSettings ?? defaultAiFeatureSettings();
}

export function bindingForCapability(
  snapshot: Pick<AiSettingsSnapshot, "bindings">,
  capability: AiCapability,
): AiCapabilityBindingRecord {
  return (
    snapshot.bindings.find((binding) => binding.capability === capability) ?? {
      capability,
      useDefault: capability !== "default",
      profileId: null,
      model: null,
      updatedAt: "",
    }
  );
}

export function findAiProfile(
  profiles: AiProviderProfileRecord[],
  profileId?: number | null,
) {
  if (!profileId) return null;
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

export function isAiCapabilityConfigured(
  snapshot: AiSettingsSnapshot | undefined,
  capability: AiCapability,
) {
  if (!snapshot) return false;
  const binding = bindingForCapability(snapshot, capability);
  if (capability !== "default" && binding.useDefault) {
    return snapshot.hasUsableDefault;
  }

  const profile = findAiProfile(snapshot.profiles, binding.profileId);
  return Boolean(profile && profile.enabled && profile.hasStoredKey && profile.supportsText);
}

export function isAiCapabilityVisible(
  snapshot: AiSettingsSnapshot | undefined,
  capability: AiManagedCapability,
) {
  const featureSettings = featureSettingsFromSnapshot(snapshot);
  return featureSettings.masterEnabled && featureSettings.capabilities[capability];
}

export function isAiFeatureVisible(
  snapshot: AiSettingsSnapshot | undefined,
  feature: AiFeatureKey,
) {
  const featureSettings = featureSettingsFromSnapshot(snapshot);
  return (
    featureSettings.masterEnabled &&
    featureSettings.capabilities[aiFeatureCapability(feature)] &&
    featureSettings.features[feature]
  );
}

export function isAiFeatureReady(
  snapshot: AiSettingsSnapshot | undefined,
  feature: AiFeatureKey,
) {
  const capability = aiFeatureCapability(feature);
  return isAiFeatureVisible(snapshot, feature) && isAiCapabilityConfigured(snapshot, capability);
}

export function visibleAiSuggestionTypes(
  snapshot: AiSettingsSnapshot | undefined,
): AiSuggestionFeatureType[] {
  const visible: AiSuggestionFeatureType[] = [];

  if (isAiFeatureVisible(snapshot, "suggestion_generation.conclusion")) {
    visible.push("conclusion");
  }
  if (isAiFeatureVisible(snapshot, "suggestion_generation.todo")) {
    visible.push("todo");
  }

  return visible;
}
