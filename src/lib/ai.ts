import { AI_PROVIDER_FAMILY_OPTIONS } from "./constants";
import type {
  AiCapability,
  AiCapabilityBindingRecord,
  AiProviderFamily,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
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
