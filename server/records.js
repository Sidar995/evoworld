/** View-only inference; never add fields to the persisted raw retry payload. */
export function modelTypeOf(record) {
  return record?.modelType ?? 'baseline';
}
export function withModelType(record) {
  return { ...record, modelType: modelTypeOf(record) };
}
