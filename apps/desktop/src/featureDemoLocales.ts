import type { FeatureOperationId } from "./canvasOperations";
type Steps = Record<0 | 1 | 2 | 3, { title: string; body: string; scene: string }>;
export const featureDemoLocales: Record<"zh-CN" | "en-US", Record<FeatureOperationId, Steps>> = {
  "zh-CN": {
    templates: {
      0: { title: "选择来源", body: "点击顶部“节点模板”，从已有节点准备模板。来源节点保持原样。", scene: "记录 A 是模板来源" },
      1: { title: "检查模板", body: "检查模板名称、正文和出站引用。已标记的秘密/TOTP 值会清空，注释保留；未标记的秘密仍需手工清理。", scene: "预览结构，不复制真实秘密" },
      2: { title: "保存并选用", body: "保存模板后，在已保存列表中选择它，填写新节点名称。若引用目标已删除，需要明确确认跳过。", scene: "选择模板，准备创建独立记录 C" },
      3: { title: "点击落点", body: "点击“到画布选择创建位置”，再点击空白画布。新节点及引用一起创建，可以一次撤销；修改模板不会改变旧节点。", scene: "新记录 C 引用共享节点 B" },
    },
    browse: {
      0: { title: "记住当前位置", body: "浏览历史记录显式跳转前的画布位置和筛选条件。普通拖动、缩放不会每次增加一步。", scene: "当前位置 A" },
      1: { title: "跳转查看", body: "切换已有画布、聚焦搜索结果或跳到位置书签，查看另一处信息。", scene: "视口移动到另一处" },
      2: { title: "返回", body: "点击顶部“返回位置”或按 Alt+←，恢复之前的位置和筛选。它不是 Ctrl+Z，不会撤销节点内容。", scene: "返回原位置 A" },
      3: { title: "前进与分支", body: "Alt+→ 可再次前进；返回后进行新的跳转或引用筛选，会清除旧前进分支。锁定或替换工作区后历史清空。", scene: "前进到刚才的位置" },
    },
    bookmarks: {
      0: { title: "确定位置", body: "先移动、缩放到希望长期保存的位置。位置书签保存画布和视口，不复制节点。", scene: "当前视口是书签目标" },
      1: { title: "保存书签", body: "打开画布栏的位置书签入口，填写名称并保存。之后可以离开这里或切换到其他画布。", scene: "保存位置标记后离开" },
      2: { title: "点击返回", body: "在书签列表点击条目，回到对应画布和缩放位置。与会话浏览历史不同，书签会随工作区保存。", scene: "书签带你回到目标位置" },
      3: { title: "维护书签", body: "列表中可以重命名、用当前位置更新或删除书签。删除书签不删除节点；删除目标画布会清理其书签。", scene: "只更新位置标记，不改节点" },
    },
    references: {
      0: { title: "从来源开始", body: "从记录 A 的出站连接端拖动，准备引用共享节点 B。引用有方向，不是复制 B 的内容。", scene: "A 是来源，B 是引用目标" },
      1: { title: "搜索目标", body: "把出站连接端拖到空白处松开，弹出搜索。空格可确认已有目标并继续搜索，Enter 结束。新建目标只用 Enter。", scene: "选择共享节点 B" },
      2: { title: "建立引用", body: "完成后 A 引用 B。之后可以用 B 筛选引用它的信息，B 本身仍可被其他记录共享。", scene: "A → B" },
      3: { title: "移除关系", body: "可以选中连线后按 Delete。移除的是引用，不是目标节点；Ctrl+Z 可撤销误删。重叠连线还可通过节点的引用入口管理。", scene: "删除连线，A 和 B 都保留" },
    },
    incoming: {
      0: { title: "区分两个方向", body: "A → B 表示 A 引用了 B。在 B 上看反向引用，就是查看“谁引用了 B”。", scene: "A 和 C 都引用 B" },
      1: { title: "打开反向引用", body: "点击节点上的被引用数量入口，查看指向该节点的来源记录。", scene: "在共享节点 B 上查看来源" },
      2: { title: "浏览来源", body: "从来源列表定位当前画布中的记录。其他画布的节点可通过全局搜索和“所在画布”定位，不需要复制节点。", scene: "从 B 找到记录 A 或 C" },
      3: { title: "按目标筛选", body: "列表底部还可按目标节点筛选来源。清除筛选可恢复完整视图；查看关系不会创建新引用。", scene: "浏览关系，原数据保持不变" },
    },
    markers: {
      0: { title: "先选中文字", body: "进入节点编辑，在正文中选中一段秘密或 TOTP 密钥。不同平台的内容可以分别标记。", scene: "选中一段演示文字" },
      1: { title: "标注用途", body: "在选区工具栏选择“秘密”或“TOTP”，按需要填写平台、用途等注释。标记和注释写入节点正文。", scene: "为选区添加用途标记" },
      2: { title: "离开编辑", body: "秘密默认遮蔽，注释仍可帮助识别。秘密标记不是磁盘加密；保存真实秘密前必须开启工作区加密。", scene: "秘密值遮蔽，说明保留" },
      3: { title: "使用 TOTP", body: "有效 TOTP 密钥可显示当前验证码；空槽位不会计算验证码。这里的数字只是演示，不运行认证器、不读取任何密钥。", scene: "虚构验证码示意，不可用于登录" },
    },
    smartQueue: {
      0: { title: "选中记录", body: "选择需要分析的一个或多个节点，加入智能引用分析队列。演示不会启动模型。", scene: "三条演示任务待处理" },
      1: { title: "后台顺序处理", body: "本地模型按顺序处理队列。分析期间可以继续其他编辑，不必一直等在结果窗口。", scene: "第一条处理完成，继续下一条" },
      2: { title: "检查建议", body: "以手动接受模式为例：查看每条记录的候选引用，确认是否符合语义。结果可以复用，但节点或模型变化后可能需要重新分析。", scene: "手动模式：候选尚未成为引用" },
      3: { title: "应用引用", body: "按当前接受方式应用候选，建立对已有节点的引用。自动引用阈值可在设置中配置；不要把匹配分数当作事实保证。", scene: "确认后才形成正式引用" },
    },
    filterContext: {
      0: { title: "选择搜索范围", body: "搜索可按名称、内容或两者进行。引用筛选支持多个标签 AND：记录必须同时满足所选引用条件。", scene: "先观察完整画布" },
      1: { title: "保留空间上下文", body: "调整未匹配节点透明度：0 表示隐藏；大于 0 时保留淡化轮廓，便于判断匹配节点的位置。", scene: "B 匹配，其余节点淡化" },
      2: { title: "只操作匹配节点", body: "淡化节点只是背景上下文，不能被拖动、选中、编辑或当作普通操作目标。需要操作它们时先修改或清除筛选。", scene: "淡化节点不是可操作目标" },
      3: { title: "定位与恢复", body: "在搜索结果中选择记录并聚焦，或清除筛选恢复完整画布。引用筛选变化也能通过浏览返回/前进恢复。", scene: "保持相对位置，浏览匹配信息" },
    },
  },
  "en-US": {
    templates: {
      0: { title: "Choose a source", body: "Open Node templates in the toolbar and prepare a template from an existing node. The source remains unchanged.", scene: "Record A is the template source" },
      1: { title: "Review the template", body: "Review its name, content and outgoing references. Marked secret/TOTP values are cleared and notes retained. Remove unmarked secrets yourself.", scene: "Reuse structure, not real secrets" },
      2: { title: "Save and select", body: "Save, select the template, and enter a new node name. Deleted reference targets require explicit consent to skip.", scene: "Prepare independent record C" },
      3: { title: "Choose a position", body: "Choose creation position, then click empty canvas. The node and references form one undoable change. Later template edits do not modify existing nodes.", scene: "New record C references shared node B" },
    },
    browse: {
      0: { title: "Capture the current place", body: "Browsing history records the canvas position and filters before explicit jumps. Ordinary pan and zoom do not add a step each time.", scene: "Starting position A" },
      1: { title: "Go elsewhere", body: "Switch to an existing canvas, focus a search result, or jump to a position bookmark.", scene: "The viewport moves elsewhere" },
      2: { title: "Go back", body: "Use Back or Alt+Left to restore the previous position and filters. This is not Ctrl+Z and does not undo node content.", scene: "Return to position A" },
      3: { title: "Forward and branches", body: "Alt+Right goes forward. A new jump or reference filter after going back clears the old forward branch. Locking or replacing the workspace clears this history.", scene: "Go forward to the visited position" },
    },
    bookmarks: {
      0: { title: "Frame a place", body: "Pan and zoom to a place worth keeping. A position bookmark stores a canvas and viewport, not copies of nodes.", scene: "The current viewport is the target" },
      1: { title: "Save a bookmark", body: "Open position bookmarks in the canvas bar, enter a name and save. You can then leave or switch canvases.", scene: "Save a position marker and leave" },
      2: { title: "Jump back", body: "Click the bookmark to return to its canvas and zoom. Unlike session browsing history, bookmarks are saved with the workspace.", scene: "The bookmark restores the target view" },
      3: { title: "Maintain bookmarks", body: "Rename, update to the current position, or delete a bookmark. This does not delete nodes. Deleting its target canvas removes its bookmarks.", scene: "Update only the position marker" },
    },
    references: {
      0: { title: "Start at the source", body: "Drag from record A's outgoing connector toward shared node B. References have direction and do not copy B's content.", scene: "A is the source; B is the target" },
      1: { title: "Search for a target", body: "Drop an outgoing connector on empty canvas to open search. Space accepts an existing target and keeps searching; Enter finishes. Creating a new target uses Enter only.", scene: "Choose shared node B" },
      2: { title: "Connect", body: "A now references B. Filter by B to find referencing records. B can still be shared by other records.", scene: "A → B" },
      3: { title: "Remove the relation", body: "Select a line and press Delete. Only the reference is removed, not the target. Ctrl+Z undoes mistakes; node reference controls also help manage overlapping lines.", scene: "Remove the line; keep A and B" },
    },
    incoming: {
      0: { title: "Understand direction", body: "A → B means A references B. Incoming references on B answer: who references B?", scene: "A and C both reference B" },
      1: { title: "Open incoming references", body: "Click the node's incoming-reference count to inspect source records pointing to it.", scene: "Inspect sources on shared node B" },
      2: { title: "Visit a source", body: "Locate a record on the current canvas from the list. For other canvases, use global search and canvas membership rather than copying nodes.", scene: "Find A or C from B" },
      3: { title: "Filter by target", body: "The footer can filter records by this target. Clear filters to restore the whole view. Reading a relation creates no new references.", scene: "Browse without changing the data" },
    },
    markers: {
      0: { title: "Select text", body: "Edit a node and select a secret or TOTP key in its content. Different platforms can have separate marked sections.", scene: "Select fictional example text" },
      1: { title: "Mark its purpose", body: "Choose Secret or TOTP in the selection toolbar and add a platform or purpose note. Markers and notes are stored in node content.", scene: "Mark the selected text" },
      2: { title: "Leave editing", body: "Secrets are masked by default while notes remain readable. Markers are not disk encryption: enable workspace encryption before storing real secrets.", scene: "Mask the value and retain its note" },
      3: { title: "Use TOTP", body: "Valid TOTP keys can display current codes. Empty slots do not calculate codes. These demo digits are fictional: no authenticator or key is accessed.", scene: "Fictional code; not usable for login" },
    },
    smartQueue: {
      0: { title: "Select records", body: "Add one or more selected nodes to the smart-reference analysis queue. This demo does not start a model.", scene: "Three fictional tasks are queued" },
      1: { title: "Process in the background", body: "Local models process tasks sequentially. Continue other editing while analysis runs rather than waiting in the results window.", scene: "The first task finishes; the next starts" },
      2: { title: "Review suggestions", body: "In manual acceptance mode, check each record's candidates. Results can be reused, but changed nodes or models may require fresh analysis.", scene: "Manual mode: suggestions are not references" },
      3: { title: "Apply references", body: "Apply candidates using the configured acceptance mode to reference existing nodes. Automatic thresholds are in settings; a similarity score is not a factual guarantee.", scene: "Accepted candidates become references" },
    },
    filterContext: {
      0: { title: "Choose search scope", body: "Search names, content or both. Multiple reference filters use AND: records must satisfy all selected references.", scene: "Start with the whole canvas" },
      1: { title: "Keep spatial context", body: "Set unmatched-node opacity: 0 hides them; a higher value retains dimmed outlines to help locate matching records.", scene: "B matches; other nodes are dimmed" },
      2: { title: "Act on matches only", body: "Dimmed nodes provide context and cannot be dragged, selected or edited. Change or clear filters before operating on them.", scene: "Dimmed nodes are not interactive targets" },
      3: { title: "Focus and recover", body: "Choose and focus a search result or clear filters for the whole canvas. Back and Forward can also restore reference-filter changes.", scene: "Browse matches with their spatial context" },
    },
  },
};
