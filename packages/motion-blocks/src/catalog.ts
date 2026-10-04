// The motion block catalogue: pure data, no React and no Remotion, so the editor tab, the sidecar and the
// Remotion bundle can all import it. A block is a Remotion animation rendered with a transparent background
// and placed on the timeline as a video; its settings (texts, placement, duration) stay editable and a change
// re-renders it.

export type MotionFieldType = "text" | "textarea" | "number" | "select" | "list";

export interface MotionField {
	key: string;
	/** Shown in the settings panel (French UI). */
	label: string;
	type: MotionFieldType;
	default: MotionValue;
	help?: string;
	/** number */
	min?: number;
	max?: number;
	step?: number;
	/** select */
	options?: Array<{ value: string; label: string }>;
	/** list: the fields of one row, and how many rows are allowed. */
	item?: MotionField[];
	maxItems?: number;
}

export type MotionValue =
	| string
	| number
	| Array<Record<string, string | number>>;
export type MotionProps = Record<string, MotionValue>;

export interface MotionBlock {
	id: string;
	label: string;
	description: string;
	/** Seconds. */
	defaultDuration: number;
	minDuration: number;
	/** Full-screen opaque shot (covers the picture) instead of a transparent overlay. */
	fullScreen: boolean;
	fields: MotionField[];
}

export const MOTION_MAX_DURATION = 60;

const PLACEMENT: MotionField[] = [
	{
		key: "placement",
		label: "Position",
		type: "select",
		default: "left",
		options: [
			{ value: "left", label: "À gauche" },
			{ value: "center", label: "Au centre" },
			{ value: "right", label: "À droite" },
		],
	},
	{
		key: "y",
		label: "Hauteur",
		type: "number",
		default: 0.45,
		min: 0.05,
		max: 0.95,
		step: 0.01,
		help: "0 = haut de l'image, 1 = bas.",
	},
	{
		key: "scale",
		label: "Taille",
		type: "number",
		default: 1.2,
		min: 0.4,
		max: 3,
		step: 0.05,
	},
];

const text = (
	key: string,
	label: string,
	value: string,
	help?: string,
): MotionField => ({
	key,
	label,
	type: "text",
	default: value,
	...(help ? { help } : {}),
});

export const MOTION_BLOCKS: readonly MotionBlock[] = [
	{
		id: "headline",
		label: "Titre",
		description:
			"Surtitre, mot d'appel et mot-clé dans une pastille de verre, avec une ligne de détail.",
		defaultDuration: 4,
		minDuration: 1.5,
		fullScreen: false,
		fields: [
			text("eyebrow", "Surtitre", "FORMATION"),
			text("lead", "Mot d'appel", "Devenir"),
			text("pill", "Mot-clé (pastille)", "Media Buyer"),
			text("micro", "Ligne de détail", "MEDIA BUYING · CLAUDE CODE · FREELANCE"),
			...PLACEMENT,
		],
	},
	{
		id: "program",
		label: "Sommaire",
		description:
			"Liste de chapitres qui s'allument l'un après l'autre, chacun avec ses étiquettes.",
		defaultDuration: 8,
		minDuration: 3,
		fullScreen: false,
		fields: [
			text("eyebrow", "Surtitre", "LE PROGRAMME"),
			{
				key: "items",
				label: "Chapitres",
				type: "list",
				maxItems: 6,
				item: [
					text("title", "Titre", "Chapitre"),
					text(
						"chips",
						"Étiquettes",
						"",
						"Séparées par des virgules.",
					),
				],
				default: [
					{ title: "La micro-entreprise", chips: "Créer, Fiscalité" },
					{ title: "Le media buying", chips: "Meta Ads, Google Ads" },
					{ title: "Réussir en freelance", chips: "Offre, Tarifs" },
				],
			},
			...PLACEMENT,
		],
	},
	{
		id: "prompt",
		label: "Barre de commande",
		description:
			"Une consigne qui se tape dans une barre de commande, puis des lignes de résultat.",
		defaultDuration: 6,
		minDuration: 2.5,
		fullScreen: false,
		fields: [
			text("eyebrow", "Surtitre", "CLAUDE CODE"),
			text("text", "Consigne tapée", "Crée ma campagne Search et rédige les annonces"),
			{
				key: "lines",
				label: "Lignes de résultat",
				type: "list",
				maxItems: 5,
				item: [text("label", "Texte", "Résultat")],
				default: [
					{ label: "Structure de campagne" },
					{ label: "Annonces rédigées" },
					{ label: "Suivi automatisé" },
				],
			},
			...PLACEMENT,
		],
	},
	{
		id: "growth",
		label: "Courbe de croissance",
		description: "Une courbe qui se trace avec un point lumineux, sans chiffre.",
		defaultDuration: 4,
		minDuration: 2,
		fullScreen: false,
		fields: [
			text("eyebrow", "Surtitre", "VOTRE ACTIVITÉ"),
			text("label", "Légende", "Faire grandir"),
			...PLACEMENT,
		],
	},
	{
		id: "stack",
		label: "Pile de cartes",
		description: "Des cartes avec icône qui s'empilent, sous un titre.",
		defaultDuration: 6,
		minDuration: 2.5,
		fullScreen: false,
		fields: [
			text("eyebrow", "Surtitre", "L'ACADÉMIE"),
			text("title", "Titre", "Tout au même endroit"),
			{
				key: "items",
				label: "Cartes",
				type: "list",
				maxItems: 5,
				item: [
					{
						key: "icon",
						label: "Icône",
						type: "select",
						default: "check",
						options: [
							{ value: "check", label: "Coche" },
							{ value: "lessons", label: "Leçons" },
							{ value: "resources", label: "Ressources" },
							{ value: "community", label: "Communauté" },
						],
					},
					text("label", "Texte", "Carte"),
					text("sub", "Sous-texte", ""),
				],
				default: [
					{ icon: "lessons", label: "Les leçons", sub: "" },
					{ icon: "resources", label: "Les ressources", sub: "" },
					{ icon: "community", label: "La communauté", sub: "pendant et après" },
				],
			},
			...PLACEMENT,
		],
	},
	{
		id: "notify",
		label: "Notifications",
		description: "Des notifications façon téléphone qui glissent et s'empilent.",
		defaultDuration: 5,
		minDuration: 2,
		fullScreen: false,
		fields: [
			{
				key: "items",
				label: "Notifications",
				type: "list",
				maxItems: 4,
				item: [
					text("app", "Application", "Communauté"),
					text("title", "Titre", "Nouvelle question"),
					text("body", "Message", ""),
				],
				default: [
					{
						app: "Communauté",
						title: "Nouvelle question",
						body: "Comment je fixe mon premier tarif ?",
					},
					{
						app: "Communauté",
						title: "Réponse de l'équipe",
						body: "On regarde ça ensemble",
					},
				],
			},
			...PLACEMENT.map((field) =>
				field.key === "placement" ? { ...field, default: "right" } : field,
			),
		],
	},
	{
		id: "cta",
		label: "Appel à l'action",
		description: "Une pastille d'appel à l'action avec une flèche et un reflet.",
		defaultDuration: 3.5,
		minDuration: 1.5,
		fullScreen: false,
		fields: [
			text("eyebrow", "Surtitre", "ON DÉMARRE"),
			text("label", "Texte", "Réserver un appel"),
			...PLACEMENT,
		],
	},
	{
		id: "pillSlot",
		label: "Plein écran : mots qui défilent",
		description:
			"Plan de coupe plein écran : une phrase fixe et une pastille dont le mot change.",
		defaultDuration: 3,
		minDuration: 1.5,
		fullScreen: true,
		fields: [
			text("stem", "Phrase fixe", "Vous saurez"),
			text(
				"pills",
				"Mots qui défilent",
				"lancer, développer, vendre",
				"Séparés par des virgules.",
			),
		],
	},
	{
		id: "scramble",
		label: "Plein écran : texte qui se décode",
		description:
			"Plan de coupe plein écran : un texte brouillé qui se révèle lettre par lettre.",
		defaultDuration: 2.5,
		minDuration: 1.2,
		fullScreen: true,
		fields: [text("text", "Texte", "IMPULSION.COM")],
	},
	{
		id: "blurSlide",
		label: "Plein écran : titre et sous-titre",
		description:
			"Plan de coupe plein écran : un titre qui arrive mot à mot, avec un sous-titre.",
		defaultDuration: 3,
		minDuration: 1.5,
		fullScreen: true,
		fields: [
			text("title", "Titre", "Avancez à votre rythme"),
			text("subtitle", "Sous-titre", "Revenez sur les leçons quand vous voulez"),
		],
	},
];

export function getMotionBlock(id: string): MotionBlock | undefined {
	return MOTION_BLOCKS.find((block) => block.id === id);
}

export class MotionPropsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MotionPropsError";
	}
}

const MAX_TEXT = 400;

function normalizeField(field: MotionField, raw: unknown, path: string): MotionValue {
	if (raw === undefined || raw === null) return structuredClone(field.default);
	switch (field.type) {
		case "text":
		case "textarea": {
			if (typeof raw !== "string")
				throw new MotionPropsError(`${path}: expected a string`);
			if (raw.length > MAX_TEXT)
				throw new MotionPropsError(`${path}: longer than ${MAX_TEXT} characters`);
			return raw;
		}
		case "number": {
			if (typeof raw !== "number" || !Number.isFinite(raw))
				throw new MotionPropsError(`${path}: expected a number`);
			const min = field.min ?? Number.NEGATIVE_INFINITY;
			const max = field.max ?? Number.POSITIVE_INFINITY;
			if (raw < min || raw > max)
				throw new MotionPropsError(`${path}: out of range ${min}..${max}`);
			return raw;
		}
		case "select": {
			const values = (field.options ?? []).map((option) => option.value);
			if (typeof raw !== "string" || !values.includes(raw))
				throw new MotionPropsError(
					`${path}: expected one of ${values.join(", ")}`,
				);
			return raw;
		}
		case "list": {
			if (!Array.isArray(raw))
				throw new MotionPropsError(`${path}: expected a list`);
			const max = field.maxItems ?? 10;
			if (raw.length > max)
				throw new MotionPropsError(`${path}: at most ${max} rows`);
			return raw.map((row, index) => {
				if (typeof row !== "object" || row === null || Array.isArray(row))
					throw new MotionPropsError(`${path}[${index}]: expected an object`);
				const out: Record<string, string | number> = {};
				const known = new Set((field.item ?? []).map((sub) => sub.key));
				for (const key of Object.keys(row)) {
					if (!known.has(key))
						throw new MotionPropsError(`${path}[${index}].${key}: unknown key`);
				}
				for (const sub of field.item ?? []) {
					const value = normalizeField(
						sub,
						Reflect.get(row, sub.key),
						`${path}[${index}].${sub.key}`,
					);
					if (Array.isArray(value))
						throw new MotionPropsError(`${path}[${index}].${sub.key}: nested list`);
					out[sub.key] = value;
				}
				return out;
			});
		}
	}
}

/** Fills the defaults and validates the props of a block. Unknown keys are refused so typos surface. */
export function normalizeMotionProps(
	block: MotionBlock,
	raw: unknown,
): MotionProps {
	const input =
		typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
	const known = new Set(block.fields.map((field) => field.key));
	for (const key of Object.keys(input)) {
		if (!known.has(key))
			throw new MotionPropsError(
				`${key}: unknown setting for block "${block.id}" (known: ${[...known].join(", ")})`,
			);
	}
	const out: MotionProps = {};
	for (const field of block.fields) {
		out[field.key] = normalizeField(field, Reflect.get(input, field.key), field.key);
	}
	return out;
}

export function clampMotionDuration(block: MotionBlock, seconds: number): number {
	return Math.min(MOTION_MAX_DURATION, Math.max(block.minDuration, seconds));
}

export function defaultMotionProps(block: MotionBlock): MotionProps {
	return normalizeMotionProps(block, {});
}
