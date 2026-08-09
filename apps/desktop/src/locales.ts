export const resources = {
  "zh-CN": {
    translation: {
      app: {
        name: "关联信息",
      },
      navigation: {
        canvas: "画布",
        nodes: "节点",
        settings: "设置",
      },
      workspace: {
        label: "工作区",
        itemCount: "{{count}} 条",
      },
      empty: {
        canvas: "画布上还没有节点",
        nodes: "还没有节点",
      },
      settings: {
        language: "界面语言",
      },
      language: {
        zhCN: "简体中文",
        enUS: "English",
      },
      storage: {
        title: "当前后端",
        development: "开发存储",
      },
    },
  },
  "en-US": {
    translation: {
      app: {
        name: "Linked Info",
      },
      navigation: {
        canvas: "Canvas",
        nodes: "Nodes",
        settings: "Settings",
      },
      workspace: {
        label: "Workspace",
        itemCount: "{{count}} items",
      },
      empty: {
        canvas: "No nodes on this canvas",
        nodes: "No nodes yet",
      },
      settings: {
        language: "Interface language",
      },
      language: {
        zhCN: "简体中文",
        enUS: "English",
      },
      storage: {
        title: "Current backend",
        development: "Development storage",
      },
    },
  },
} as const;

export type SupportedLanguage = keyof typeof resources;

export const supportedLanguages: SupportedLanguage[] = ["zh-CN", "en-US"];
