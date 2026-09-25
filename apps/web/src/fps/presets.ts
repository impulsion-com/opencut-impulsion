// NTSC rates (23.976, 29.97, 59.94) map to 24000/1001, 30000/1001 and
// 60000/1001 through floatToFrameRate; projects reach them from NTSC imports.
export const FPS_PRESETS = [
	{ value: "23.976", label: "23.976 fps" },
	{ value: "24", label: "24 fps" },
	{ value: "25", label: "25 fps" },
	{ value: "29.97", label: "29.97 fps" },
	{ value: "30", label: "30 fps" },
	{ value: "59.94", label: "59.94 fps" },
	{ value: "60", label: "60 fps" },
	{ value: "120", label: "120 fps" },
] as const;
