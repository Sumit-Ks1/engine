/** Only plain numeric ids are ever forwarded to the engine. */
export const safeId = (id: string) => (/^\d{1,12}$/.test(id) ? id : '0');
