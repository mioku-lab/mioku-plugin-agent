import type { AgentBaseConfig } from "../types";

export const BASE_CONFIG: AgentBaseConfig = {
  access: {
    allowAdmins: false,
    users: [],
  },
  workspaceDir: "",
  permissionLevel: "workspace-write",
  model: "",
};
