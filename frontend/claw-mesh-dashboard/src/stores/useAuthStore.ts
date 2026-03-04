import { create } from 'zustand';

// ============ 权限定义 ============
export const PERMISSIONS = {
  // 视图级
  VIEW_MESH: 'mesh:read',
  VIEW_TASKS: 'tasks:read',
  VIEW_LOGS: 'logs:read',
  VIEW_AI: 'ai:read',
  VIEW_SETTINGS: 'settings:read',

  // 操作级（需宪法层审计）
  MODIFY_CONFIG: 'config:write',
  TRIGGER_ROLLBACK: 'system:rollback',
  BATCH_DISPATCH: 'tasks:dispatch',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type PermissionId = typeof PERMISSIONS[PermissionKey];

// 需要宪法层审计的权限
const CONSTITUTION_AUDITED: Set<PermissionId> = new Set([
  PERMISSIONS.MODIFY_CONFIG,
  PERMISSIONS.TRIGGER_ROLLBACK,
]);

export type UserRole = 'admin' | 'operator' | 'viewer';

interface User {
  id: string;
  name: string;
  role: UserRole;
  permissions: PermissionId[];
}

// 角色→权限映射
const ROLE_PERMISSIONS: Record<UserRole, PermissionId[]> = {
  admin: Object.values(PERMISSIONS),
  operator: [
    PERMISSIONS.VIEW_MESH,
    PERMISSIONS.VIEW_TASKS,
    PERMISSIONS.VIEW_LOGS,
    PERMISSIONS.VIEW_AI,
    PERMISSIONS.VIEW_SETTINGS,
    PERMISSIONS.BATCH_DISPATCH,
  ],
  viewer: [
    PERMISSIONS.VIEW_MESH,
    PERMISSIONS.VIEW_TASKS,
    PERMISSIONS.VIEW_LOGS,
  ],
};

interface AuthState {
  user: User;
  isAuthenticated: boolean;
  constitutionAuditLog: Array<{ permission: string; timestamp: number; userId: string }>;

  login: (userId: string, name: string, role: UserRole) => void;
  logout: () => void;
  hasPermission: (permission: PermissionKey) => boolean;
  checkAndAudit: (permission: PermissionKey) => boolean;
}

// 默认 admin（单用户模式，后续接入认证系统）
const DEFAULT_USER: User = {
  id: 'admin-local',
  name: 'Admin',
  role: 'admin',
  permissions: Object.values(PERMISSIONS),
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: DEFAULT_USER,
  isAuthenticated: true,
  constitutionAuditLog: [],

  login: (userId, name, role) => {
    set({
      user: {
        id: userId,
        name,
        role,
        permissions: ROLE_PERMISSIONS[role] || [],
      },
      isAuthenticated: true,
    });
  },

  logout: () => {
    set({ user: DEFAULT_USER, isAuthenticated: false });
  },

  hasPermission: (permission) => {
    const { user } = get();
    const permId = PERMISSIONS[permission];
    return user.permissions.includes(permId);
  },

  checkAndAudit: (permission) => {
    const { user, constitutionAuditLog } = get();
    const permId = PERMISSIONS[permission];
    const allowed = user.permissions.includes(permId);

    // 宪法层审计：敏感操作记录日志
    if (CONSTITUTION_AUDITED.has(permId)) {
      const entry = {
        permission: permId,
        timestamp: Date.now(),
        userId: user.id,
      };

      set({
        constitutionAuditLog: [...constitutionAuditLog, entry].slice(-100),
      });

      console.log(`[Constitution] Audit: ${user.id} → ${permId} (${allowed ? 'ALLOWED' : 'DENIED'})`);
    }

    return allowed;
  },
}));

// ============ 权限 Hook（供组件使用）============
export function usePermission(permission: PermissionKey) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const checkAndAudit = useAuthStore((s) => s.checkAndAudit);

  return {
    can: hasPermission(permission),
    /** 执行操作前调用——敏感操作会写入宪法审计日志 */
    require: () => {
      const allowed = checkAndAudit(permission);
      if (!allowed) {
        throw new Error(`Permission denied: ${permission}`);
      }
      return true;
    },
  };
}
