// Freesound is optional in the local build. Without FREESOUND_API_KEY the
// search route answers with this status and code instead of calling out.
export const SOUNDS_NOT_CONFIGURED_STATUS = 503;
export const SOUNDS_NOT_CONFIGURED_CODE = "freesound_not_configured";

export async function isSoundsNotConfigured({
	response,
}: {
	response: Response;
}): Promise<boolean> {
	if (response.status !== SOUNDS_NOT_CONFIGURED_STATUS) return false;
	try {
		const body = await response.clone().json();
		return body?.code === SOUNDS_NOT_CONFIGURED_CODE;
	} catch {
		return false;
	}
}
