"use client";

import type {
	MotionField,
	MotionProps,
	MotionValue,
} from "@opencut/motion-blocks/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { SectionField } from "@/components/section";

type Row = Record<string, string | number>;

function rowsOf(value: MotionValue | undefined): Row[] {
	return Array.isArray(value) ? value : [];
}

function emptyRow(fields: MotionField[]): Row {
	const row: Row = {};
	for (const field of fields) {
		row[field.key] =
			typeof field.default === "number" ? field.default : String(field.default ?? "");
	}
	return row;
}

function ScalarInput({
	field,
	value,
	onChange,
	disabled,
}: {
	field: MotionField;
	value: string | number;
	onChange: (value: string | number) => void;
	disabled: boolean;
}) {
	if (field.type === "select") {
		return (
			<Select
				value={String(value)}
				onValueChange={(next) => onChange(next)}
				disabled={disabled}
			>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(field.options ?? []).map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}
	if (field.type === "number") {
		return (
			<Input
				type="number"
				value={String(value)}
				min={field.min}
				max={field.max}
				step={field.step}
				disabled={disabled}
				onChange={(event) => {
					const parsed = Number.parseFloat(event.target.value);
					if (Number.isFinite(parsed)) onChange(parsed);
				}}
			/>
		);
	}
	return (
		<Input
			value={String(value)}
			disabled={disabled}
			maxLength={400}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

/** The editable settings of one block, driven by its field list. */
export function MotionFields({
	fields,
	values,
	onChange,
	disabled,
}: {
	fields: MotionField[];
	values: MotionProps;
	onChange: (values: MotionProps) => void;
	disabled: boolean;
}) {
	return (
		<>
			{fields.map((field) => {
				if (field.type !== "list") {
					const current = values[field.key];
					return (
						<SectionField key={field.key} label={field.label}>
							<ScalarInput
								field={field}
								value={Array.isArray(current) || current === undefined ? "" : current}
								disabled={disabled}
								onChange={(next) => onChange({ ...values, [field.key]: next })}
							/>
							{field.help ? (
								<p className="text-muted-foreground text-xs">{field.help}</p>
							) : null}
						</SectionField>
					);
				}
				const itemFields = field.item ?? [];
				const rows = rowsOf(values[field.key]);
				const setRows = (next: Row[]) => onChange({ ...values, [field.key]: next });
				return (
					<SectionField key={field.key} label={field.label}>
						<div className="flex flex-col gap-2">
							{rows.map((row, index) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
									key={index}
									className="bg-accent/40 flex flex-col gap-1.5 rounded-md border p-2"
								>
									{itemFields.map((sub) => (
										<ScalarInput
											key={sub.key}
											field={sub}
											value={row[sub.key] ?? ""}
											disabled={disabled}
											onChange={(next) =>
												setRows(
													rows.map((other, otherIndex) =>
														otherIndex === index ? { ...other, [sub.key]: next } : other,
													),
												)
											}
										/>
									))}
									<Button
										variant="ghost"
										size="sm"
										className="text-muted-foreground self-end"
										disabled={disabled}
										onClick={() =>
											setRows(rows.filter((_, otherIndex) => otherIndex !== index))
										}
									>
										Retirer
									</Button>
								</div>
							))}
							<Button
								variant="outline"
								size="sm"
								disabled={disabled || rows.length >= (field.maxItems ?? 10)}
								onClick={() => setRows([...rows, emptyRow(itemFields)])}
							>
								Ajouter une ligne
							</Button>
						</div>
					</SectionField>
				);
			})}
		</>
	);
}
