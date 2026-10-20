# 天涯明月刀 OL · 全服功力榜（自动每日更新）

用 GitHub Actions 每天北京时间 13:00 自动抓取排行榜数据，构建静态站点并部署到 GitHub Pages。
地址固定为 `https://<你的用户名>.github.io/<仓库名>/`，永久有效、免费。

数据源：`rank.qquu.chat`（抓自天刀官方名人堂）
当前范围：5 大区 16 服（已排除天下无双大区），约 2.6 万名角色、2000+ 帮派。

---

## 一、建仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `tianya-rank`（或任意英文名，建议全小写）
3. 可见性选 **Public**（私有仓库的 Pages 需要付费，公开仓库完全免费）
4. 不要勾选 README / .gitignore / license（保持空仓库）
5. 点 **Create repository**

## 二、上传文件

### 方式 A：网页拖拽（不需要装任何东西）

1. 在仓库页面点 **Add file → Upload files**
2. 把本项目文件夹里的**全部内容**（包括 `.github` 这个隐藏文件夹）一起拖进浏览器
3. 底部点 **Commit changes**

> 注意：`.github/workflows/daily.yml` 必须落在 `.github/workflows/` 目录下，路径错了 Actions 不会出现。如果拖拽后看不到 `.github`，用方式 B。

### 方式 B：命令行（如果你电脑装了 git）

```bash
cd 这个文件夹
git init
git add .
git commit -m "初始化：天刀全服功力榜"
git branch -M main
git remote add origin https://github.com/<你的用户名>/tianya-rank.git
git push -u origin main
```

> Windows 用户也可以装 [GitHub Desktop](https://desktop.github.com/)，点几下就能传。

## 三、开启 Pages

1. 仓库 **Settings → Pages**
2. **Source** 选 **GitHub Actions**（不要选 Deploy from a branch）
3. 不用保存，选完即生效

## 四、先手动跑一次

1. 仓库顶部 **Actions** 标签
2. 左侧点 **每日同步功力榜**
3. 右侧 **Run workflow → Run workflow**
4. 等约 20 分钟（首次要抓 2.6 万条角色曲线），进度可点进去看

跑完后：

- 站点地址：`https://<你的用户名>.github.io/<仓库名>/`
  也可以在 Actions 的 deploy 步骤里点那个链接直接打开
- 之后每天北京时间 13:00 自动执行，无需再管

## 五、改配置

| 想改什么 | 改哪里 |
|---|---|
| 排除某个大区 | `update.py` 顶部的 `EXCLUDE_REGIONS` |
| 排除单个服务器 | `update.py` 顶部的 `EXCLUDE_SERVERS`（填服务器 id，如 `'2101'`） |
| 改同步时间 | `.github/workflows/daily.yml` 里的 `cron`，注意是 **UTC**：北京时间 13:00 = `0 5 * * *` |
| 换数据源 | `update.py` 顶部的 `API` |

改完提交，下次运行自动生效；想立刻生效就在 Actions 里手动 Run 一次。

## 常见问题

**Actions 里报错 `抓取结果为空`**
数据源临时抽风。不用处理，避免写入空数据是故意设计的保护；过一会儿手动 Run 一次即可。

**曲线抓取很慢 / 部分角色没有曲线**
数据源限流，脚本用 6 并发（实测 12 并发会全部失败）。个别请求失败会自动跳过，不影响整体。

**Pages 打开是 404**
确认 Settings → Pages 的 Source 选的是 **GitHub Actions**，并且至少成功跑过一次 workflow。

**国内访问慢**
GitHub Pages 在国内时快时慢。要稳定就得换国内 OSS/COS 托管（需要域名备案），或绑定自己的 CDN。

## 目录说明

```
.github/workflows/daily.yml   定时任务：抓数据 → 构建 → 部署 Pages
update.py                     抓取 + 生成各服数据（核心）
gen_agg.py                    生成全区全服 / 各大区聚合榜
gen_ghist.py                  用角色 30 天曲线回溯帮派 30 天功力
build_template.py             把 CSS / JS 内联进 index.html 生成模板
index.html                    页面骨架
style.css                     样式
app.js                        前端全部交互逻辑
```
