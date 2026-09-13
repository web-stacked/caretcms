import type { AuthorizationAction } from '../types.js';
import { getRequestContext } from './request-context.js';
import type { CmsMutationCommand } from './mutations/contracts.js';

export class PermissionDenied extends Error {
  constructor() { super('Permission denied'); this.name = 'PermissionDenied'; }
}

/** Absent policy preserves legacy authenticated-editor access. HTTP routes
 * still authenticate first; this helper never grants an anonymous session. */
export async function canPerform(action: AuthorizationAction, collection?: string, id?: string): Promise<boolean> {
  const authorize = getRequestContext()?.authorize;
  return authorize ? authorize(action, collection, id) : true;
}

export async function requirePermission(action: AuthorizationAction, collection?: string, id?: string): Promise<void> {
  if (!(await canPerform(action, collection, id))) throw new PermissionDenied();
}

export async function canMutate(command: CmsMutationCommand): Promise<boolean> {
  if (command.type === 'create_collection' || command.type === 'delete_collection') {
    return canPerform('manageCollections', command.id);
  }
  if (command.type === 'reorder_entries') {
    for (const item of command.items) if (!(await canPerform('edit', command.collection, item.id))) return false;
    return true;
  }
  if (!(await canPerform('edit', command.collection, command.id))) return false;
  return command.type !== 'delete_entry' || canPerform('delete', command.collection, command.id);
}
