export type VoiceCallStatus = { ready: boolean; transcribe: boolean };

export type VoiceCallPlan =
  | { kind: "device"; transcribe: false }
  | { kind: "provider"; transcribe: boolean }
  | { kind: "settings" }
  | { kind: "dictation" };

export type VoiceCallPlanDeps = {
  loadDeviceVoiceEnabled: () => Promise<boolean>;
  dictationAvailable: () => Promise<boolean>;
  loadVoiceStatus: () => Promise<VoiceCallStatus>;
};

/**
 * Chooses the call input/output path before any provider setup is required.
 * A device voice preference is fail-closed like speakText: a read failure must
 * not turn a local-only reply into hosted voice traffic. Settings is only ever the
 * answer when nothing can hear the caller: on-device dictation opens a working call.
 */
export async function resolveVoiceCallPlan(deps: VoiceCallPlanDeps): Promise<VoiceCallPlan> {
  let deviceVoiceEnabled = false;
  try {
    deviceVoiceEnabled = await deps.loadDeviceVoiceEnabled();
  } catch {
    deviceVoiceEnabled = true;
  }

  const deviceDictationAvailable = deviceVoiceEnabled ? await deps.dictationAvailable() : false;
  if (deviceVoiceEnabled && deviceDictationAvailable) {
    return { kind: "device", transcribe: false };
  }

  // A probe that fails is a provider that is not there, and an unreachable provider must
  // never dead-end the mic at the settings panel.
  let status: VoiceCallStatus;
  try {
    status = await deps.loadVoiceStatus();
  } catch {
    status = { ready: false, transcribe: false };
  }

  if (!status.ready) {
    // No provider: on-device dictation still opens a working call whenever the device can
    // hear the caller, whatever the device-voice preference is set to.
    if (await deps.dictationAvailable()) return { kind: "device", transcribe: false };
    return deviceVoiceEnabled ? { kind: "dictation" } : { kind: "settings" };
  }

  if (!status.transcribe) {
    const canDictate = deviceVoiceEnabled
      ? deviceDictationAvailable
      : await deps.dictationAvailable();
    if (!canDictate) return { kind: "dictation" };
  }

  return { kind: "provider", transcribe: status.transcribe };
}

/** True only when the provider is ready to transcribe. Any other outcome is false. */
export async function probeProviderTranscribe(
  loadVoiceStatus: () => Promise<VoiceCallStatus>,
): Promise<boolean> {
  try {
    const status = await loadVoiceStatus();
    return status.ready && status.transcribe;
  } catch {
    return false;
  }
}

/** Personalize the greeting only when the profile arrives within 500 ms. */
export async function loadCallCallerName(
  loadMe: () => Promise<{ name?: string | null }>,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const me = await Promise.race([
      loadMe(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      }),
    ]);
    return me?.name?.trim().split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
