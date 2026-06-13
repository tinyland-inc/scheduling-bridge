/**
 * PII redaction annotations for journaled `stateDelta` (design §5 "PII hygiene",
 * risk 9: "Schema redaction on encode; TTL purge; volatile never persisted").
 *
 * The journal is reconciliation EVIDENCE, not a data store: a redacted row proves a
 * step ran and what it provided WITHOUT carrying the raw client name/email/intake
 * answers. We mark PII-bearing schema positions with a plain effect/Schema
 * annotation (not `Schema.Redacted`, which is a `Declaration` AST node and would
 * fail the `jsonEncodableViolations` fence — see state-conformance.ts) and apply the
 * redaction during the segment-boundary encode in run.ts.
 *
 * Redaction is a non-reversible placeholder, NOT a hash: a hash of a low-entropy
 * field (first name, email) is trivially rainbow-tabled, so it would not actually
 * protect the value. We replace the encoded leaf with a typed placeholder that
 * preserves shape (null stays null; strings/records collapse to the marker) so the
 * stateDelta still round-trips structurally through `decodeStateDelta` on resume —
 * resume re-runs the open segment from its head anyway (browser state is not
 * serializable, §5), so the redacted client/confirmation fields are never needed as
 * control state; the unredacted command/initial state seeds the re-run.
 */

import { SchemaAST, Option, type Schema } from 'effect';

/**
 * Annotation id marking a schema position as PII. Read back off the AST during the
 * stateDelta encode. A `Symbol.for` so the id is stable across module instances
 * (the conformance test resolves the same symbol).
 */
export const PiiRedactionAnnotationId: unique symbol = Symbol.for(
	'scheduling-bridge/flow/PiiRedaction',
);

/** Placeholder substituted for a redacted PII value in a journaled stateDelta. */
export const REDACTED_PLACEHOLDER = '[redacted]';

/** Mark a flow-state schema position as PII to be redacted on journal encode. */
export const redactable = <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, I, R> =>
	schema.annotations({ [PiiRedactionAnnotationId]: true });

/** Whether an AST node carries the PII redaction annotation. */
export const isRedacted = (ast: SchemaAST.AST): boolean =>
	Option.isSome(SchemaAST.getAnnotation<boolean>(PiiRedactionAnnotationId)(ast));

/**
 * Recursively replace every value position whose schema AST carries the PII
 * annotation with the placeholder, preserving structural shape (null is left as
 * null; everything else collapses to the marker). Walks the ENCODED AST so the
 * value/schema shapes line up (the value passed in is already Schema-encoded).
 *
 * If ANY enclosing node is annotated, the whole subtree is redacted (a struct can
 * be marked PII wholesale, or individual leaves). Unannotated branches recurse so
 * non-PII fields (e.g. confirmation.appointmentId) survive verbatim.
 */
const redactValue = (ast: SchemaAST.AST, value: unknown): unknown => {
	if (isRedacted(ast)) return value === null ? null : REDACTED_PLACEHOLDER;

	switch (ast._tag) {
		case 'TypeLiteral': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
			const literal = ast as SchemaAST.TypeLiteral;
			const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
			for (const prop of literal.propertySignatures) {
				if (typeof prop.name === 'symbol') continue;
				const name = String(prop.name);
				if (name in out) out[name] = redactValue(prop.type, out[name]);
			}
			// Index signatures (records): redact every member if the value type is annotated.
			for (const index of literal.indexSignatures) {
				if (!isRedacted(index.type)) continue;
				for (const k of Object.keys(out)) {
					if (!literal.propertySignatures.some((p) => String(p.name) === k)) {
						out[k] = out[k] === null ? null : REDACTED_PLACEHOLDER;
					}
				}
			}
			return out;
		}
		case 'Union': {
			// NullOr(T) and similar: try each member; the redacting one wins.
			const union = ast as SchemaAST.Union;
			for (const member of union.types) {
				if (isRedacted(member)) return value === null ? null : REDACTED_PLACEHOLDER;
			}
			// No annotated member: recurse into the non-null branch shape if possible.
			for (const member of union.types) {
				if (member._tag === 'TypeLiteral' || member._tag === 'TupleType') {
					return redactValue(member, value);
				}
			}
			return value;
		}
		case 'TupleType': {
			if (!Array.isArray(value)) return value;
			const tuple = ast as SchemaAST.TupleType;
			return value.map((item, i) => {
				const element = tuple.elements[i]?.type ?? tuple.rest[0]?.type;
				return element ? redactValue(element, item) : item;
			});
		}
		case 'Refinement':
			return redactValue((ast as SchemaAST.Refinement).from, value);
		case 'Transformation':
			return redactValue(SchemaAST.encodedAST(ast), value);
		default:
			return value;
	}
};

/**
 * Redact a Schema-ENCODED value against its schema, replacing annotated PII
 * positions with the placeholder. Pass the encoded AST (the value is already on the
 * Encoded side); callers in run.ts use `SchemaAST.encodedAST(spec[key].ast)`.
 */
export const redactEncoded = (encodedAst: SchemaAST.AST, value: unknown): unknown =>
	redactValue(encodedAst, value);
