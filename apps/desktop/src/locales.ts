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
      actions: {
        newNode: "新建节点",
        editNode: "编辑节点",
        save: "保存",
        cancel: "取消",
        close: "关闭",
      },
      search: {
        label: "搜索节点",
        placeholder: "按名称搜索",
      },
      empty: {
        canvas: "画布上还没有节点",
        nodes: "还没有节点",
      },
      nodes: {
        noContent: "无内容",
      },
      editor: {
        createTitle: "新建节点",
        editTitle: "编辑节点",
        name: "名称",
        namePlaceholder: "输入唯一名称",
        content: "内容",
        contentPlaceholder: "输入纯文本内容",
      },
      validation: {
        nameRequired: "名称不能为空",
        nameUnique: "该名称已经存在",
      },
      references: {
        sourceHandle: "拖动以引用其他节点",
        targetHandle: "拖到这里建立引用",
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
        local: "本地存储",
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
      actions: {
        newNode: "New node",
        editNode: "Edit node",
        save: "Save",
        cancel: "Cancel",
        close: "Close",
      },
      search: {
        label: "Search nodes",
        placeholder: "Search by name",
      },
      empty: {
        canvas: "No nodes on this canvas",
        nodes: "No nodes yet",
      },
      nodes: {
        noContent: "No content",
      },
      editor: {
        createTitle: "New node",
        editTitle: "Edit node",
        name: "Name",
        namePlaceholder: "Enter a unique name",
        content: "Content",
        contentPlaceholder: "Enter plain text content",
      },
      validation: {
        nameRequired: "Name is required",
        nameUnique: "This name already exists",
      },
      references: {
        sourceHandle: "Drag to reference another node",
        targetHandle: "Drop here to create a reference",
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
        local: "Local storage",
      },
    },
  },
} as const;

export type SupportedLanguage = keyof typeof resources;

export const supportedLanguages: SupportedLanguage[] = ["zh-CN", "en-US"];
