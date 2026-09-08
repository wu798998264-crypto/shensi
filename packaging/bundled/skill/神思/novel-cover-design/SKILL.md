---
schema_version: 2
id: shensi.novel-cover-design
name: 小说封面设计
version: 1.0.0
author: 神思团队
description: 为长篇小说和网文建立可执行的封面设计合同、文字安全区、排版验证、多个成品方向与资产标注。
capability_boundary: 只负责小说封面的视觉决策、生成提示词和成品验收；不直接调用模型、接口或文件系统，不修改正文与正史，实际生图由神思可信媒体链执行。
source: bundled_local
capabilities:
  - novel_cover_designer
role: auxiliary
workspace_modes:
  - project
  - notebook
  - general
artifact_types:
  - novel_cover_plan
  - novel_cover_prompt
  - novel_cover_validation
input_requirements:
  - book_title
  - author_name
  - genre_or_synopsis
  - target_platform_or_ratio
output_contract: novel_cover_plan_v1
stages:
  - planning
  - visual-generation
  - visual-revision
conflict_policy: advisory
fallback: builtin
trigger_keywords:
  - 小说封面
  - 网文封面
  - 书封
  - 封面设计
  - 设计封面
  - 制作封面
  - 生成封面
  - 检查封面
trigger_conditions:
  - "text_any: 小说|网文|书籍|书名|作品|作者|出版|番茄|起点|晋江|七猫|阅文|书封"
---

# 小说封面设计

## 目标

把“生成一张好看的图”升级为可验证的小说封面交付。你负责封面设计判断，神思现有图片生成链负责模型调用、任务恢复、下载和历史资产落盘。

## 启动边界

只有请求明确指向小说、网文或书籍封面时才启用。普通插画、人物立绘、场景图、视频封面和文章配图不自动启用本 Skill。

进入成品生成前至少确认：

- 书名；
- 作者名或笔名；
- 题材、核心卖点或剧情梗概；
- 目标平台或画幅。

书名或作者名缺失时先提出最少必要问题，不能猜测，也不能把占位符当成成品文字。

## 封面设计合同

每次先建立 `novel_cover_plan_v1`：

- `bookTitle`：逐字保留的书名；
- `authorName`：逐字保留的作者名；
- `genre`、`audience`、`platform`、`aspectRatio`；
- `readerPromise`：缩略图第一眼必须传达的题材与冲突承诺；
- `visualHierarchy`：标题、主体、题材线索、作者名的视觉优先级；
- `safeArea`：文字与关键主体的安全范围；
- `directions`：三个成品方向；
- `validation`：生成前与生成后的检查结论。

默认竖版画幅为 2:3。平台有明确规格时，以平台规格为准并记录覆盖原因。

## 文字安全区

除非平台模板另有要求，默认：

- 左右各至少保留画面宽度的 8%；
- 顶部至少保留 8%，底部至少保留 10%；
- 标题建议位于画面高度的 10%—32%；
- 作者名建议位于画面高度的 78%—88%；
- 人脸、关键动作、核心道具与辨识意象不得落入标题字形背后；
- 缩略到平台列表尺寸后，书名仍须可辨认。

平台裁切区、角标区或榜单徽标区优先级高于默认安全区。

## 三个成品方向

首次方案必须给出三个有实质差异的方向，不能只换配色：

1. 人物冲突方向：以主角、关系或决定性动作建立冲突。
2. 世界奇观方向：以地点、世界规则或大事件建立类型承诺。
3. 意象字形方向：以单一核心意象和标题字形建立高辨识度。

每个方向都要分别给出：一句话概念、主体、构图、色彩、光线、标题区、作者名区、负面约束和适用理由。用户选定方向后，再把该方向编译为干净的生图提示词；用户明确要求批量成品时，三个方向分别生成并分别落盘，不能拼成一张九宫格冒充三个成品。

## 标题与作者名排版验证

生成前检查：

- 书名和作者名是否完整、精确；
- 标题是否为第一或第二视觉层级；
- 字形、颜色、描边与背景是否有足够对比；
- 标题、作者名、主体与平台角标是否互相避让；
- 是否存在不必要的副标题、宣传语、水印或伪文字。

生成后检查：

- 书名逐字一致；
- 作者名逐字一致；
- 没有乱码、镜像字、缺字、重字或擅自新增文案；
- 文字没有越出安全区或压住关键主体；
- 缩略图和完整图两个尺度均可读；
- 画幅、裁切和内容与选定方向一致。

若图片模型无法稳定生成精确中文，不接受乱码成品。应生成无文字或无伪文字的干净底图，同时输出可复现的标题、作者名、字体气质、字号层级、位置与颜色叠加规格。

## 历史资产标注

每个封面成品必须随媒体任务保存以下元数据：

```yaml
assetType: novel_cover
coverContractVersion: 1
bookTitle: 精确书名
authorName: 精确作者名
directionId: character-conflict
directionLabel: 人物冲突方向
platform: 目标平台
aspectRatio: 2:3
safeArea:
  left: 8
  right: 8
  top: 8
  bottom: 10
```

历史资产中的方向 ID 可使用：

- `character-conflict`
- `world-spectacle`
- `symbolic-typography`

资产卡应展示“小说封面”、书名和方向标签；提示词仍按现有历史资产规则保存。上游素材不重复写入封面元数据。

## 输出规则

规划请求输出封面合同和三个方向；生成请求只输出当前方向可直接使用的媒体提示词；检查请求输出逐项验证结果和明确的返工建议。交付内容只呈现用户所需的封面方案、生成要求与验收结论，不展示实现细节。
