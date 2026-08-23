// Compatibility no-ops kept so existing routes do not need to know that the
// local SQLite mirror was removed. GitHub is now the sole persistent database.
export function sqMirrorInsertProject(_name: string, _description: string | null, _apiKey: string): void {}
export function sqMirrorDeleteProject(_id: number): void {}
export function sqMirrorInsertCollection(_pgId: number, _projectId: number, _collection: string, _data: Record<string, unknown>): void {}
export function sqMirrorUpdateCollection(_id: number, _data: Record<string, unknown>): void {}
export function sqMirrorDeleteCollection(_id: number): void {}
export function sqMirrorUpsertGameCache(_pgId: number, _projectId: number, _namespace: string, _cacheKey: string, _data: Record<string, unknown>, _expiresAt: string | null): void {}
export function sqMirrorDeleteGameCache(_projectId: number, _namespace: string, _cacheKey: string): void {}
export function sqMirrorLogRequest(_projectId: number, _method: string, _endpoint: string): void {}
export function sqGetDatabaseHealth(): { ok: boolean; latencyMs: number } { return { ok: true, latencyMs: 0 }; }
