export const bodyText = (body: unknown): string => (typeof body === 'string' ? body : '');
