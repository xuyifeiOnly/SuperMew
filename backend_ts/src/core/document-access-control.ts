import type { Role } from '../types.js';
import { DocumentAccessControl } from '../models.js';

const quoteMilvusString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const normalizeRole = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const normalizeRoles = (roles: Role[]): string[] => [...new Set(roles.map(normalizeRole).filter(Boolean))];

export const parseAllowedRoles = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeRole).filter(Boolean))];
  }

  const raw = String(value ?? '').trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map(normalizeRole).filter(Boolean))];
    }
  } catch {}

  return [...new Set(raw.split(/[,\n，]/).map(normalizeRole).filter(Boolean))];
};

export const listDocumentAccessRules = async (): Promise<Array<{ filename: string; allowed_roles: string[] }>> => {
  const rows = await DocumentAccessControl.findAll({
    attributes: ['filename', 'allowedRoles'],
    raw: true,
  });
  return rows
    .map((item) => ({
      filename: String(item.filename ?? '').trim(),
      allowed_roles: parseAllowedRoles(item.allowedRoles ?? []),
    }))
    .filter((item) => item.filename);
};

export const setDocumentAllowedRoles = async (filename: string, allowedRoles: string[]): Promise<void> => {
  const normalizedRoles = [...new Set(allowedRoles.map(normalizeRole).filter(Boolean))];
  if (!normalizedRoles.length) {
    await DocumentAccessControl.destroy({ where: { filename } });
    return;
  }
  await DocumentAccessControl.upsert({
    filename,
    allowedRoles: normalizedRoles,
  });
};

export const deleteDocumentAccessRule = async (filename: string): Promise<void> => {
  await DocumentAccessControl.destroy({ where: { filename } });
};

export const clearDocumentAccessRules = async (): Promise<number> => {
  return await DocumentAccessControl.destroy({ where: {} });
};

export const buildAccessibleFilterExpr = async (
  roles: Role[],
  baseExpr: string,
): Promise<{ filterExpr: string; accessScope: 'all' | 'role_filtered'; restrictedFileCount: number }> => {
  const currentRoles = normalizeRoles(roles);
  const effectiveRoles = currentRoles.length ? currentRoles : ['user'];
  const rules = await listDocumentAccessRules();
  const excludedFilenames = rules
    .filter((item) => item.allowed_roles.length > 0 && !item.allowed_roles.some((role) => effectiveRoles.includes(role)))
    .map((item) => item.filename);

  if (!excludedFilenames.length) {
    return {
      filterExpr: baseExpr,
      accessScope: 'all',
      restrictedFileCount: 0,
    };
  }

  const excludeExpr = excludedFilenames
    .map((filename) => `filename != "${quoteMilvusString(filename)}"`)
    .join(' and ');

  return {
    filterExpr: baseExpr ? `(${baseExpr}) and ${excludeExpr}` : excludeExpr,
    accessScope: 'role_filtered',
    restrictedFileCount: excludedFilenames.length,
  };
};
