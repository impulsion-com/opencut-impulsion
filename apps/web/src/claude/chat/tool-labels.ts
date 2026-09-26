import type { ToolName } from "@opencut/claude-tools";

// French labels for the chat panel's tool chips and permission prompts. Typed on ToolName so a tool added to
// the contract fails to compile here until it has a label.

const TOOL_LABELS: Readonly<Record<ToolName, string>> = {
	get_editor_state: "Lit la timeline",
	get_element: "Inspecte un élément",
	list_capabilities: "Consulte les possibilités de l'éditeur",
	list_media: "Liste les médias",
	list_projects: "Liste les projets",
	capture_frame: "Regarde l'image",
	capture_contact_sheet: "Regarde une planche d'images",
	peek_media: "Regarde un média",
	apply_edit_plan: "Modifie la timeline",
	mark_ranges: "Marque des passages",
	undo: "Annule une étape",
	redo: "Rétablit une étape",
	seek: "Déplace la tête de lecture",
	play: "Lance la lecture",
	pause: "Met en pause",
	select: "Sélectionne des éléments",
	set_editor_modes: "Règle les modes d'édition",
	create_project: "Crée un projet",
	open_project: "Ouvre un projet",
	switch_scene: "Change de scène",
	save_project: "Enregistre le projet",
	list_disk_media: "Parcourt les fichiers du disque",
	import_media: "Importe des médias",
	remove_media: "Retire des médias",
	start_export: "Lance l'export",
	job_status: "Suit une tâche",
	cancel_job: "Annule une tâche",
};

const MCP_PREFIX = "mcp__opencut__";

function isKnownTool(name: string): name is ToolName {
	return Object.prototype.hasOwnProperty.call(TOOL_LABELS, name);
}

/** "Modifie la timeline" for apply_edit_plan; "Outil <name>" for anything outside the opencut catalogue. */
export function getToolLabel(name: string | null): string {
	if (!name) return "Outil";
	const bare = name.startsWith(MCP_PREFIX)
		? name.slice(MCP_PREFIX.length)
		: name;
	return isKnownTool(bare) ? TOOL_LABELS[bare] : `Outil ${bare}`;
}

const JOB_KIND_LABELS: Readonly<Record<string, string>> = {
	export: "Export",
	import: "Import",
	transcription: "Transcription",
};

export function getJobKindLabel(kind: string): string {
	return JOB_KIND_LABELS[kind] ?? kind;
}

const JOB_PHASE_LABELS: Readonly<Record<string, string>> = {
	queued: "En attente",
	running: "En cours",
	rendering: "Rendu",
	uploading: "Envoi du fichier",
	copying: "Copie",
	probing: "Analyse",
	adding: "Ajout au projet",
	done: "Terminé",
	failed: "Échec",
	cancelled: "Annulé",
};

export function getJobPhaseLabel(phase: string): string {
	return JOB_PHASE_LABELS[phase] ?? phase;
}
