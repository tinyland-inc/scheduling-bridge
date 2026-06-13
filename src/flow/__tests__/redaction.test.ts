/**
 * PII redaction annotations (design §5 "PII hygiene", risk 9). The journaled
 * stateDelta encode path (run.ts) must replace annotated PII positions with a
 * non-reversible placeholder while leaving non-PII fields verbatim and preserving
 * null shape — and the annotations must NOT change the encoded AST tag (so the
 * JSON-encodability fence still passes).
 */

import { Schema, SchemaAST } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	PiiRedactionAnnotationId,
	REDACTED_PLACEHOLDER,
	isRedacted,
	redactEncoded,
	redactable,
} from '../redaction.js';
import { jsonEncodableViolations } from '../state-conformance.js';

const encodeRedacted = <A, I>(schema: Schema.Schema<A, I>, value: A): unknown =>
	redactEncoded(
		SchemaAST.encodedAST(schema.ast),
		Schema.encodeUnknownSync(schema)(value as never),
	);

describe('PII redaction annotations', () => {
	it('marks a schema position with the redaction annotation without changing its AST tag', () => {
		const plain = Schema.String;
		const marked = redactable(Schema.String);
		expect(plain.ast._tag).toBe('StringKeyword');
		expect(marked.ast._tag).toBe('StringKeyword');
		expect(isRedacted(plain.ast)).toBe(false);
		expect(isRedacted(marked.ast)).toBe(true);
		expect(PiiRedactionAnnotationId.toString()).toContain('PiiRedaction');
	});

	it('redactable schemas remain JSON-encodable (the fence does not trip)', () => {
		const spec = {
			a: redactable(Schema.String),
			b: redactable(Schema.NullOr(Schema.String)),
			c: redactable(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String }))),
		};
		expect(jsonEncodableViolations(spec)).toEqual([]);
	});

	it('redacts a marked leaf string to the placeholder', () => {
		expect(encodeRedacted(redactable(Schema.String), 'jane@example.com')).toBe(
			REDACTED_PLACEHOLDER,
		);
	});

	it('preserves null shape on a redacted NullOr field', () => {
		const schema = redactable(Schema.NullOr(Schema.String));
		expect(encodeRedacted(schema, null)).toBe(null);
		expect(encodeRedacted(schema, 'secret')).toBe(REDACTED_PLACEHOLDER);
	});

	it('redacts marked struct fields and leaves unmarked fields verbatim', () => {
		const Client = Schema.Struct({
			firstName: redactable(Schema.String),
			lastName: redactable(Schema.String),
			email: redactable(Schema.String),
			phone: redactable(Schema.NullOr(Schema.String)),
			notes: redactable(Schema.NullOr(Schema.String)),
			customFields: redactable(
				Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })),
			),
			// NOT PII — must survive verbatim.
			serviceId: Schema.String,
		});
		const out = encodeRedacted(Client, {
			firstName: 'Jane',
			lastName: 'Doe',
			email: 'jane@example.com',
			phone: '555-1212',
			notes: 'allergic to lavender',
			customFields: { health: 'sciatica' },
			serviceId: '53178494',
		});
		expect(out).toEqual({
			firstName: REDACTED_PLACEHOLDER,
			lastName: REDACTED_PLACEHOLDER,
			email: REDACTED_PLACEHOLDER,
			phone: REDACTED_PLACEHOLDER,
			notes: REDACTED_PLACEHOLDER,
			customFields: REDACTED_PLACEHOLDER,
			serviceId: '53178494',
		});
	});

	it('is non-reversible: the placeholder retains no fragment of the original value', () => {
		const out = encodeRedacted(redactable(Schema.String), 'Jane Doe <jane@example.com>') as string;
		expect(out).toBe(REDACTED_PLACEHOLDER);
		expect(out).not.toContain('Jane');
		expect(out).not.toContain('jane@example.com');
	});
});
