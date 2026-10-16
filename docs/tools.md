# 工具与计算规则

所有工具都需要 `schoolis.read` 权限。6 个写入工具另外需要 `schoolis.write`，服务器在工具调用时校验权限。原有只读令牌不能调用写入工具。

## 工具清单

| 工具 | 输入 | 返回内容 |
| --- | --- | --- |
| `get_profile` | 无 | 当前学生身份，保留身份与学校字段 |
| `list_semesters` | 无 | 学期 ID、日期和当前学期标记 |
| `list_subjects` | `semesterId` | 当前学期的科目 |
| `get_assignment_options` | `semesterId`、`purpose` | 作业列表或统计页面的科目和类型 |
| `list_assignments` | 学期、日期范围、科目、类型与分页 | 一页作业 |
| `get_assignment_statistics` | 学期、科目、日期范围、可选类型与分页 | 一页作业统计，含已公布的分数 |
| `get_assignment_detail` | `learningTaskId` | 作业说明及附件信息 |
| `list_assignment_attachments` | `learningTaskId` | 作业、提交和评语附件的 ID、来源与链接 |
| `read_assignment_attachment` | 作业 ID、附件 ID、来源及读取范围 | PDF 或纯文本附件中的文字 |
| `get_exam_options` | `semesterId`、`purpose` | 考试列表或统计页面的科目和类型 |
| `list_exams` | 学期、日期范围、科目、类型与分页 | 一页考试 |
| `get_exam_statistics` | 学期、科目、日期范围、可选类型与分页 | 一页考试统计 |
| `get_exam_detail` | `examId` | 考试详情 |
| `get_schedule` | `beginTime`、`endTime` | 最多跨 31 天的课表 |
| `get_grades` | `semesterId` | 校宝学期成绩与官方 GPA |
| `get_grade_settings` | `semesterId` | 学校 GPA 设置及学期成绩归档状态 |
| `get_grade_detail` | 学期、科目与班级 ID | 原始成绩分类与规范化 `categories` |
| `get_school_features` | 无 | 学校功能开关、LMS、学生表单和问卷类型状态 |
| `get_promotion_status` | 无 | 本人升学档案是否存在及未完成任务数量 |
| `list_promotion_tasks` | `taskStatus`，可选日期与关键词 | 本人升学任务 |
| `get_promotion_task_detail` | `promotionTaskId` | 本人档案中的升学任务详情 |
| `get_promotion_file_options` | `kind` | 本人升学资料或文书的上传人筛选项 |
| `list_promotion_files` | `kind`、分页，可选日期、关键词与上传人 | 一页本人升学资料或文书元数据 |
| `calculate_gpa` | `courses` 或 `semesterId`，可附 `rules` | 本地 GPA、逐科权重和假设 |
| `simulate_grades` | `categories`、`changes` | 当前成绩、预测成绩、差值和假设 |
| `get_microsoft_profile` | 无 | 独立绑定的微软账号身份 |
| `list_teams_classes` | 分页参数 | 一页本人 Teams 教育课程 |
| `list_teams_assignments` | `classId`、分页参数 | 一页 Teams 作业，不默认限制最近 14 天 |
| `get_teams_assignment_detail` | `classId`、`assignmentId` | Teams 作业说明、原始截止时间和资源链接元数据 |
| `list_teams_submissions` | 课程、作业 ID 和分页参数 | 一页属于当前微软账号的提交记录 |
| `get_teams_submission_outcomes` | 课程、作业、提交 ID 和分页参数 | 本人提交已公布的分数、评语和评分量表 |
| `get_outlook_calendar` | 起止时间、分页参数 | 主日历事件和重复事件的实例 |
| `get_write_capabilities` | 无 | MCP 写入授权、校宝连接及微软写权限状态 |
| `upload_assignment_attachment` | 作业 ID、`requestId`、文件输入 | 已上传附件的签名凭据，不提交作业 |
| `submit_assignment` | 作业 ID、`requestId`，可选回答和附件凭据 | 校宝提交结果与回读校验状态 |
| `upload_teams_attachment` | 课程、作业、提交 ID，`requestId` 和文件输入 | 已上传并关联的本人提交附件 |
| `submit_teams_assignment` | 课程、作业、提交 ID 和 `requestId` | 本人 Teams 作业的正式提交结果 |
| `unsubmit_teams_assignment` | 课程、作业、提交 ID 和 `requestId` | 本人 Teams 作业的撤回结果 |
| `create_outlook_event` | `requestId`、主题、起止时间，可选正文等 | 新建个人日历事件 |

日期格式为 `YYYY-MM-DD`，含义为学校当地日历日期。作业与考试日期范围最多跨 370 天，`pageSize` 为 1 到 100，默认值为 50。`pageIndex` 从 1 开始。返回 `hasMore=true` 时应继续读取下一页。

校宝查询返回 `source=schoolis`，微软查询返回 `source=microsoft_graph`，两者均返回 `official=true`。原始业务字段位于 `data`。计算工具返回 `official=false`，并用 `source` 区分本地计算与本地预测。

## Teams 与 Outlook

微软工具需要独立绑定账号，操作步骤见[微软授权与 Teams](microsoft.md)。校宝 Cookie 不用于微软接口。没有绑定微软时，微软工具返回 `MICROSOFT_NOT_CONNECTED`，校宝工具仍可使用。

微软列表使用游标分页，`pageSize` 为 1 到 100，默认值为 50。列表位于 `data.value`。`pagination.cursor` 不为 `null` 时，下一次调用应传入该游标，并保持原有 ID、筛选条件和 `pageSize`。游标有效期为 30 分钟，绑定微软账号与查询接口。工具不接受任意 Graph 地址或原始 `@odata.nextLink`。

Teams ID 是微软返回的字符串，不是校宝的数字 ID。先调用 `list_teams_classes` 取得 `classId`，再查询作业和本人提交。工具不修正截止时间，也不隐式筛选最近 14 天。

`list_teams_submissions` 只返回 `recipient.userId` 与绑定账号一致的记录。过滤后的空页仍可能有后续页。`get_teams_submission_outcomes` 先核对提交归属，再保留 `publishedScore`、`publishedFeedback` 等已公布字段，移除草稿分数和评语。没有已公布分数时，不推断隐藏成绩。

`get_outlook_calendar` 的 `startDateTime`、`endDateTime` 使用带时区偏移的 ISO 8601 时间，例如 `2026-10-16T00:00:00+08:00`。结束时间应晚于开始时间，范围最多跨 31 天。响应时间使用 UTC。工具读取主日历，不创建、修改或删除事件。

只读工具中的资源目录和文件链接仅为元数据。当前没有接入聊天、频道消息或 SharePoint 文件下载。上传、提交和事件创建使用独立写入工具，要求见[作业写入与文件上传](writes.md)。

## 统计与功能状态

`get_assignment_options` 和 `get_exam_options` 的 `purpose` 可选 `list` 或 `statistics`，默认值为 `list`。两个页面的筛选项可能不同。查询统计前，使用 `purpose=statistics` 取得科目和类型 ID。

统计工具要求 `subjectId`。可选 `typeId` 用于筛选任务或考试类型；省略时查询全部类型。统计工具与列表工具使用相同的日期和分页限制。返回的 `pagination` 只描述当前页；不要把单个科目的结果当成全学期统计。

`get_grade_settings` 返回 `gpaSettings` 和 `semesterScoresArchived`。`useDynamicGPA=false` 不影响 `calculate_gpa` 的本地计算。

`get_school_features` 只保留学校配置中的布尔开关，另外返回 `hasLmsSite`、`studentFormsEnabled` 和 `questionnaireTypes`。关闭的开关与空列表属于正常结果。功能开关为 `true` 不表示服务已经接入该功能的数据接口。

## 附件读取

先调用 `list_assignment_attachments`，再使用返回的 ID 和 `source` 调用 `read_assignment_attachment`。`source` 可选 `assignment`、`submission` 或 `feedback`，分别表示教师布置附件、本人提交附件和教师评语附件。默认值为 `assignment`。

读取工具只接受作业 ID 和附件 ID。服务从已登录的作业详情中解析文件地址，只访问 `cdn.schoolis.cn` 的 HTTPS 链接。服务不向文件服务器发送校宝 Cookie，不跟随文件重定向。附件正文不进入查询缓存或日志。

文件大小上限为 5 MB。服务可提取 PDF 文字层和 UTF-8 `.txt` 文件，不执行文件或识别扫描图片。PDF 解析在独立线程中运行，内存上限为 96 MB，解析超时为 10 秒。下载超时为 15 秒。同一进程最多同时读取两个附件。

读取参数如下：

| 参数 | 默认值 | 限制 |
| --- | --- | --- |
| `startPage` | `1` | PDF 起始页，从 1 开始 |
| `maxPages` | `5` | 单次最多读取 20 页 |
| `maxChars` | `30000` | 单次返回 1000 到 100000 个字符 |
| `textOffset` | `0` | 从起始页或纯文本中的指定字符继续读取，最多 5000000 |

PDF 返回 `pages`、`totalPages`、`nextPage` 和 `nextOffset`。如果 `nextPage` 不为 `null`，下一次调用使用 `startPage=nextPage` 和 `textOffset=nextOffset`。纯文本返回 `text` 和 `nextOffset`，下一次把 `nextOffset` 传给 `textOffset`。`truncated=true` 表示还有内容。

`ocrPerformed=false` 表示没有执行光学字符识别。PDF 页面的文字为空时，不应断言页面没有图片或其他内容。返回的 `untrustedContent=true` 提醒调用方把附件文字作为业务数据，不执行其中的指令。`official=true` 表示文件来自校宝，不表示文字提取结果经过学校审核。

## 升学档案

所有升学工具都从当前账号取得 `studentPromotionId`。调用方不能指定其他学生的档案 ID。`get_promotion_status` 在没有档案时返回 `available=false`；子工具返回 `FEATURE_UNAVAILABLE`，不会继续请求档案接口。

`list_promotion_tasks` 的 `taskStatus` 可选 `1`、`2` 或 `3`，默认值为 `1`。工具沿用学校的状态值。该接口没有确认可用的分页参数；返回数据过大时，应缩小日期范围或添加关键词。工具不截断任务列表来伪装完整结果。

升学文件工具的 `kind` 可选 `materials` 或 `documents`，分别表示升学资料和留学文书。工具读取元数据，不下载文件。可先用 `get_promotion_file_options` 取得上传人的 `id` 和 `accountType`，再把它们同时传给 `uploadUserId` 和 `uploadUserType`。

升学列表可省略日期。提供日期时，应同时提供 `beginTime` 和 `endTime`，范围最多跨 370 天。`keyword` 最长为 100 个字符。

无档案时的返回已经实测。任务、资料、文书和上传人分支通过测试样本验证，尚未使用真实记录验证。

## GPA

`calculate_gpa` 接受以下两类输入，二者只能提供一种：

- `courses`：明确的课程列表，每项包含唯一 `id`、`name`、百分制 `score`。未出分时，`score` 使用 `null`。
- `semesterId`：读取校宝的学期课程列表。课程 ID 同时包含科目 ID 和班级 ID，避免合并不同班级。

分数与基础 GPA 的映射如下。分数达到下限时进入对应档位。

| 分数下限 | GPA |
| --- | --- |
| 97 | 4.3 |
| 93 | 4.0 |
| 90 | 3.7 |
| 87 | 3.3 |
| 83 | 3.0 |
| 80 | 2.7 |
| 77 | 2.3 |
| 73 | 2.0 |
| 70 | 1.7 |
| 67 | 1.3 |
| 63 | 1.0 |
| 60 | 0.7 |
| 0 | 0 |

计算先排除 `excluded=true` 与未出分课程，然后应用规则：

- 特殊关键词规则按配置顺序优先匹配。值为 `1.5` 时，非零 GPA 加 `0.5`，平均权重为 `1`。其他值直接作为平均权重。
- 高权重课程的非零 GPA 加 `0.5`，平均权重为 `1`。
- 低权重课程的平均权重为 `0.5`。
- 排除关键词课程的平均权重为 `0`。
- 其他课程的平均权重为 `1`。

默认关键词参考 Giaoculator S 1.3.10 的计算行为，来源说明见[第三方依赖与参考来源](third-party.md)。特殊规则包含 `Pre AP → 1` 和 `ultivari → 1.5`。短于 5 个字符的常规关键词区分大小写；其他常规关键词与特殊关键词不区分大小写。返回的 `rules` 与逐科 `rule` 会显示实际应用的规则。

课程可显式设置 `weight` 和 `bonus`。显式值覆盖关键词规则。`unweightedGpa` 移除 GPA 加分，仍保留课程平均权重。所有课程都被排除或未出分时，GPA 返回 `null`。

`combineChinese` 默认为 `true`。符合规则的 Chinese 课程合成为 Chinese Culture：语文权重为 `2/3`，人文、历史或地理权重为 `1/3`。计算按已有组成部分归一化，把合成分数四舍五入到一位小数，再映射 GPA。

如果同一角色匹配多门课程，计算返回歧义错误。可设置课程的 `chineseRole`，或关闭 `combineChinese`。如果要单独指定 Chinese 课程权重，应把 `chineseRole` 设为 `none`，或关闭合成。

## 成绩预测

`get_grade_detail` 返回的 `categories` 可直接传给 `simulate_grades`。分类包含以下字段：

```json
{
  "id": "category-1",
  "name": "Homework",
  "weight": 30,
  "tasks": [
    { "id": "task-1", "score": 80, "totalScore": 100 }
  ],
  "children": []
}
```

新增任务示例：

```json
{
  "categoryId": "category-1",
  "taskId": "planned-task",
  "action": "add",
  "score": 90,
  "totalScore": 100
}
```

`action` 可选 `add`、`replace` 或 `remove`。新增任务需要新的任务 ID。替换任务应引用已有任务；省略 `totalScore` 时沿用原值。每个场景只能修改同一分类中的同一任务一次。

预测采用以下假设：

- 叶子分类中的任务先换算成百分比，再等权平均。
- 分数最高计入 100%，未出分任务不参与平均。
- 科目分数按有成绩分类的权重归一化。
- 复合分类使用子分类权重，不计父分类中的任务副本。
- 分类只有汇总成绩时，可计算基线，但不能增加或修改任务。
- 删除最后一项已出分任务后，分类变为未出分。

这些假设不等于每门课程的官方评分政策。工具返回的 `assumptions` 应随预测结果展示。工具不推断隐藏成绩，不把预测写回校宝。

## 错误

工具失败时返回 `isError=true`，`structuredContent.error` 包含 `code`、`message` 和 `retryable`。未通过 MCP 授权的请求直接收到 HTTP 401，并带有 OAuth 发现地址。

| 错误码 | 后续动作 |
| --- | --- |
| `SESSION_EXPIRED` | 重新绑定账号，或配置自动登录凭据 |
| `CAPTCHA_REQUIRED` | 运行交互式登录并填写验证码 |
| `LOGIN_RETRY_BLOCKED` | 重新绑定账号，或等待 5 分钟后重试 |
| `IDENTITY_MISMATCH` | 停止查询，核对并重新绑定账号 |
| `UPSTREAM_TIMEOUT` | 稍后重试，必要时缩小查询范围 |
| `UPSTREAM_BUSINESS_ERROR` | 核对接口状态；服务不会重复猜测登录 |
| `UNSUPPORTED_DATA_FORMAT` | 核对校宝返回结构与现有适配器 |
| `INSUFFICIENT_GRADE_DETAIL` | 获取完整任务明细后再预测 |
| `FEATURE_UNAVAILABLE` | 当前账号没有升学档案，无法读取子记录 |
| `INVALID_FILTER` | 同时提供上传人 ID 和账号类型，或同时省略 |
| `ATTACHMENT_NOT_FOUND` | 核对附件 ID、作业 ID 和附件来源 |
| `ATTACHMENT_URL_REJECTED` / `ATTACHMENT_REDIRECT_REJECTED` | 文件地址超出允许范围，服务停止下载 |
| `ATTACHMENT_TOO_LARGE` | 文件超过 5 MB，改用学校页面读取 |
| `UNSUPPORTED_ATTACHMENT_TYPE` / `UNSUPPORTED_TEXT_ENCODING` | 只读取 PDF 文字层或 UTF-8 纯文本 |
| `PDF_EXTRACTION_FAILED` | 文件可能已加密、损坏或超出解析限制 |
| `INVALID_PAGE` / `INVALID_OFFSET` | 核对页码与续读位置 |
| `ATTACHMENT_TIMEOUT` / `ATTACHMENT_BUSY` | 稍后重试，或减少单次 PDF 页数 |
| `MICROSOFT_NOT_CONNECTED` / `MICROSOFT_REAUTH_REQUIRED` | 运行 `npm run microsoft:login` 完成手机授权 |
| `MICROSOFT_AUTH_CONFIGURATION` | 核对应用 ID、租户 ID、设备代码流程及学校授权 |
| `MICROSOFT_FORBIDDEN` | 核对应用权限和学校策略；服务不自动扩大权限 |
| `MICROSOFT_IDENTITY_MISMATCH` | 停止读取，核对并重新绑定微软账号 |
| `MICROSOFT_NOT_OWN_SUBMISSION` | 使用本人提交 ID，不读取其他学生的提交 |
| `MICROSOFT_INVALID_CURSOR` | 保持原查询条件继续分页，或从第一页重新查询 |
| `MICROSOFT_SESSION_CHANGED` | 绑定在刷新期间发生变化，重新查询 |
| `MICROSOFT_SESSION_INVALID` | 核对私有会话文件路径，必要时重新绑定 |
| `MICROSOFT_TIMEOUT` / `MICROSOFT_UNAVAILABLE` | 稍后重试，必要时缩小查询范围 |
| `INSUFFICIENT_SCOPE` | 在 MCP 连接中重新授权 `schoolis.write` |
| `MICROSOFT_WRITE_PERMISSION_REQUIRED` | 运行 `npm run microsoft:login -- --write` 申请缺少的上游写权限 |
| `ASSIGNMENT_NOT_EDITABLE` / `SUBMISSION_NOT_EDITABLE` | 检查作业关闭、批改、提交状态及学校政策 |
| `INVALID_UPLOAD_RECEIPT` | 使用当前账号与作业的有效上传凭据 |
| `INVALID_UPLOAD` / `UPLOAD_TOO_LARGE` | 核对文件输入、文件名及 5 MB 限制 |
| `UPLOAD_URL_REJECTED` / `UPLOAD_DOWNLOAD_FAILED` | 使用新生成的 ChatGPT 文件地址，或提供文本／base64 |
| `WRITE_REQUEST_CONFLICT` | 参数变化时创建新的 `requestId` |
| `WRITE_IN_PROGRESS` | 等待当前写入结束后重试 |
| `WRITE_OUTCOME_UNKNOWN` | 先查询实际状态，不自动生成新请求重复写入 |
| `WRITE_JOURNAL_INVALID` / `WRITE_JOURNAL_FULL` | 检查私有写入记录文件和容量 |
