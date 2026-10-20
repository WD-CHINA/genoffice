---
name: sync-upstream
description: >-
  Compare and merge genspark-ai/genoffice upstream/main into the current branch,
  including conflict preview and viewer rendering impact. Use when the user
  mentions 同步上游, 上游分支, upstream snapshot, Sync snapshot, or asks what
  would change or how rendering would change if this branch syncs upstream.
---

# 同步上游

上游远程是 `upstream`（`genspark-ai/genoffice`），分支是 `upstream/main`。当前功能分支经常只改 `apps/viewer`。对比和同步都用这个流程。用中文汇报。

不要改 git config，不要 force push，不要 `reset --hard`，不要 `--no-verify`。用户只问差异时不要合并，也不要 push。用户明确说同步时才合并。

## 1. 取上游

```bash
git fetch upstream
git status -sb
git rev-parse --abbrev-ref HEAD
git log -1 --oneline
git rev-parse upstream/main
```

用户给出提交号时，先确认它是 `upstream/main` 的祖先或正是 tip。tip 不一致就以 `upstream/main` 为准，并在汇报里写明。

## 2. 对比

记 `BASE=$(git merge-base HEAD upstream/main)`。

```bash
git rev-list --left-right --count HEAD...upstream/main
git log --oneline --no-merges HEAD..upstream/main
git log --oneline --no-merges upstream/main..HEAD
git diff --shortstat "$BASE"...upstream/main
comm -12 \
  <(git diff --name-only "$BASE"..HEAD | sort) \
  <(git diff --name-only "$BASE"..upstream/main | sort)
git merge-tree --write-tree --name-only HEAD upstream/main
```

`merge-tree` 退出码 0 且只打印一棵 tree 表示没有冲突。非 0 就列出冲突文件，停在这里，等用户决定要不要手工解。

汇报结构：

- 分叉点、当前 HEAD、上游 tip，以及两边各多几个提交
- 上游有、当前没有的提交，按应用归纳，不要贴完整 diffstat
- 当前有、上游没有的提交
- 两边都改过的文件，以及各自改了什么（`git diff "$BASE"..HEAD -- <file>` 和上游侧对照）
- 预演能否干净合并

## 3. 渲染影响

viewer 的画面来自这些包，不来自 `apps/docs`、`apps/slides`、`apps/sheets` 的编辑器：

- `packages/pptx-render`、`packages/viewer-renderers`：PPT / PDF / Word 的绘制
- `packages/docx-engine` 的 `parse.ts`：Word 解析。viewer 经 `packages/viewer-renderers/src/docs/renderer/parse-worker.ts` 调用 `parseDocx`
- `packages/pptx-engine`：打开与物化幻灯片。旁白接口不参与绘制，除非 viewer 主动调用
- `packages/ui/src/dropdown.css`：PDF 预览会引入。viewer 自己的菜单在 `packages/viewer-renderers/src/ui/dropdown.tsx`，弹出层是 `.gs-dd-pop` 直接包 `.gs-dd-item`，没有 `.gs-dd-list`

判断规则：

- `pptx-render` 和 `viewer-renderers` 没有改：PPT、PDF 像素不变
- `docx-engine` 的 `parse.ts` 有改：只看 viewer 实际读取的字段。`paraMarkDel` 会画出来（整段删除会收起，只删段落标记会带删除样式）。把 `w:moveFrom` 并进 `paraMarkDel` 会改变带「移动段落」修订的文档。`paraMarkIns` 解析出来但 viewer 的 `convert.ts` 不读，画面不变
- `dropdown.css` 里 `.has-search`、`.gs-dd-search`、`.gs-dd-list` 不影响现有 PDF 菜单
- `xlsx-gateway`、表格编辑器、幻灯片录旁白 UI 不进入 viewer 预览

汇报时分开写「viewer 预览」和「套件编辑器」。后者的新绘制（单元格图片、旁白、水印）不要说成 viewer 的变化。

## 4. 合并

只在用户要求同步、且第 2 步没有冲突时执行。提交说明沿用仓库里已有的合并句式：

```bash
git merge upstream/main -m "$(cat <<'EOF'
Merge branch 'genspark-ai:main' into main

EOF
)"
```

合并后确认：

```bash
git status -sb
git log -1 --format='%h %p %s'
git diff HEAD^1 HEAD --stat -- apps/viewer
```

`HEAD^1` 是合并前的当前分支。上游没改 viewer 时，这条 diff 应为空。有冲突或 hook 失败就停，不要 `--no-verify`，也不要 amend 这次合并。不要 push，除非用户另外要求。
