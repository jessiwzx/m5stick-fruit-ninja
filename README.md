# M5StickS3 体感水果忍者

用 **M5Stack StickS3** 当体感手柄玩的网页版水果忍者。转动设备，刀就跟着走，挥过水果即可切开。

> Browser Fruit Ninja controlled by an M5Stack StickS3 running the AirStick BLE-mouse firmware.

---

## 在线试玩

**https://jessiwzx.github.io/m5stick-fruit-ninja/**

不需要装任何东西。没有 StickS3 也能玩：点「开始体感」锁定鼠标后，普通鼠标移动同样能带动刀（刀的位置由鼠标位移累积决定）。触屏设备不行，那套逻辑依赖 `movementX/Y`。

## 硬件要求

| 项 | 说明 |
|---|---|
| 设备 | M5Stack **StickS3**（ESP32-S3 + BMI270 六轴，BLE 5.0） |
| 固件 | **AirStick**（[Teapot174/AirMouseS3](https://github.com/Teapot174/AirMouseS3)，MIT）——把设备刷成蓝牙鼠标 |
| 主机 | 任意支持 Canvas 的桌面浏览器（Chrome / Edge） |

设备刷好 AirStick 后与电脑蓝牙配对，系统会把它识别成一只鼠标。本项目**不需要改固件、不需要额外驱动**。

## 本地运行

```bash
# 方式一：双击
开始游戏.bat

# 方式二：任意静态服务器
python -m http.server 8124
# 然后打开 http://localhost:8124/
```

必须走 HTTP 打开，直接双击 `index.html` 会因为 `file://` 协议加载不了资源。

## 操作

| 动作 | 怎么做 |
|---|---|
| 移动刀 | 转动 StickS3（像端托盘一样，屏幕朝上） |
| 切水果 | 挥过去就行，不用按键 |
| 回中 | `空格` —— 刀漂到屏幕边缘时把它拉回中心 |
| 调灵敏度 | `[` 减小 · `]` 增大 |
| 调纵向手感 | `,` · `.` |
| 调试面板 | `F1`（显示实时位移、饱和触发、零偏估计） |
| 暂停 | `Esc` |

**刀会自己往一边漂？** 按住机身侧边 **B 键约 1 秒**并保持静止再松开，固件会重新标定陀螺仪零偏，漂移能降一个量级。这是最有效的一招。

## 玩法

选模式后开局，三种模式规则不同：

| 模式 | 时长 | 炸弹 | 命 |
|---|---|---|---|
| 经典 | 无限（3 条命耗尽结束） | 切到即结束 | 3 |
| 禅 | 90 秒 | 不出现 | 无 |
| 街机 | 60 秒 | 扣 10 分 + 锁刀 0.9 秒，不结束 | 无 |

三种特殊香蕉：

| 香蕉 | 效果 | 时长 |
|---|---|---|
| 冰冻（蓝） | 全场减速到 0.3 倍，给你喘息 | 5 秒 |
| 双倍（金） | 得分 ×2 | 10 秒 |
| 狂热（白） | 出场密度提升、同屏上限放宽 | 8 秒 |

计分规则：

- **连击**：1.5 秒内连续切中，倍率 1 → 2 → 3（同一刀切多个只算一次连击，不算多次）
- **暴击**：切点落在水果中心 45% 半径内，该次得分 ×2，飘 `CRITICAL`
- **一刀多切**：单刀切中 ≥3 个额外加成

## 技术说明

设备侧的关键约束来自 AirStick 固件源码：

- 单次采样位移上限 `kMaxStep = 40px`，超出**直接丢弃不补发**。横向 16px/度，意味着角速度超过 250°/s 就开始丢角度 —— 快速挥手时会觉得「甩不动」。这里做了软膝补偿：34px 以下完全线性（不破坏精细操作），34→40 渐进放大到 1.6 倍
- 固件开机 `gyroBias = 0`、无死区，不标定就有 1~5°/s 持续漂移。这里只在真静止（±1px）时学习零偏，用整数累加器长期精确扣除
- 两轴增益不等：横向 16px/度，纵向只有 9.5px/度，必须乘 **1.684** 补偿

输入通道用 Pointer Lock + `unadjustedMovement`，绕开系统指针加速。所有补偿都在 `scripts/airstick.js` 里，游戏本体只读取算好的位移。

## 与原版的差异

原版是 [blueWhale1202/fruit-ninja](https://github.com/blueWhale1202/fruit-ninja)（MIT）。改动集中在三处：

1. **`scripts/all.js`** —— `getCoors` 改为读取体感层算好的坐标（只读不累加）；`timeline` 换成可缩放虚拟时钟（冰冻道具用）；新增三种特殊香蕉、连击倍率、暴击判定、一刀多切；修了四处原版崩溃点（`anims.clear`、炸弹 `timer2` 未定义、`knife.pause`、炸弹落地清理）
2. **`scripts/airstick.js`** —— 全新增的体感适配层，约 400 行
3. **`scripts/modes.js`** —— 全新，模式选择界面、HUD、结算、再来一局

原版素材与核心玩法结构未改动。

### 已修的原版缺陷

| 现象 | 原因 | 修法 |
|---|---|---|
| 手快时选完模式立刻被弹回标题页 | `scripts/main.js` 的 `start()` 里有个「加载完 3 秒无条件 `switchSence("home-menu")`」的定时器，且没有任何取消机制，对局中途触发就把人踢走 | 定时器存进 `exports.__homeTimer`，`modes.js` 的 `chooseMode()` 里取消它 |
| 禅 / 街机模式右上角一直挂着 3 条命 | `sence.showNewGame()` 无条件调 `lose.show()`；而 `enterGame` 里调的 `lose.setVisible` / `fps.hide` 前者签名不符、后者方法根本不存在，异常被 `catch` 吞掉 | `lose` 补真正的 `setVisible(v)`，并用 `forcedHidden` 标记挡住 `show()` / `showLoseAt()`；删掉不存在的 `fps.hide()` |

## 目录结构

```
.
├── index.html              入口
├── 开始游戏.bat            本地一键启动
├── server.js               兜底静态服务器（没 Python 时用）
├── scripts/
│   ├── all.js              原版游戏逻辑（已按上面所述扩展）
│   ├── airstick.js         体感适配层
│   └── modes.js            模式 / HUD / 结算
├── images/  sound/  favicon/
├── _backup/                开发回退备份（已在 .gitignore 排除，不随仓库分发）
├── README.original.md      原版 README，保留备查
└── LICENSE.txt             原版 MIT 授权
```

## 致谢

- 游戏原作：[blueWhale1202/fruit-ninja](https://github.com/blueWhale1202/fruit-ninja)，MIT License, Copyright (c) 2025 Prof. Evan Wehner
- 设备固件：[Teapot174/AirMouseS3](https://github.com/Teapot174/AirMouseS3)，MIT License

## License

MIT。见 [LICENSE.txt](LICENSE.txt)，原版权声明保留不变。
