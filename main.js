/*
 * Edit Lock Indicator
 * ---------------------------------------------------------------
 * 여러 사용자가 클라우드 동기화(예: Syncthing, Google Drive, OneDrive,
 * 네트워크 공유 폴더, Obsidian Sync 등)로 하나의 보관함(vault)을 공유해서
 * 쓸 때, "지금 이 파일을 다른 사용자가 편집 중이다"라는 것을 알려주는
 * 소프트 락(soft-lock) 표시 플러그인입니다.
 *
 * 동작 원리
 * - 보관함 안에 아주 작은 JSON 파일(_locks/edit-locks.json)을 두고,
 *   각 사용자의 옵시디언이 주기적으로 이 파일을 읽고/씁니다.
 * - 이 파일이 동기화 프로그램을 통해 다른 기기로 전파되면서
 *   "누가 어떤 파일을 열어놨는지" 정보가 공유됩니다.
 * - 별도의 서버/네트워크 통신은 하지 않습니다. (기존 동기화 수단에 의존)
 * - 따라서 이것은 "완벽한 잠금"이 아니라 "경고성 표시"입니다.
 *   실제로 다른 사용자의 편집을 막지는 못합니다.
 */

const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

// ⚠️ 이 설정들은 loadData()/saveData()를 통해 보관함 안의
// .obsidian/plugins/edit-lock-indicator/data.json 에 저장됩니다.
// 이 파일은 보관함과 함께 "동기화되는" 파일이므로, 여기에는
// 절대로 사용자 개인 식별 정보(이름/ID/색상)를 넣으면 안 됩니다.
// (넣으면 동기화될 때마다 서로의 이름/ID를 덮어써서 모두가 같은
// 사용자로 보이는 문제가 생깁니다. 아래 identity 관련 코드 참고.)
const DEFAULT_SETTINGS = {
	lockFolder: "_locks",
	lockFileName: "edit-locks.json",
	tickSeconds: 5, // 하트비트/폴링 주기
	staleSeconds: 25, // 이 시간 동안 갱신이 없으면 잠금이 만료된 것으로 간주
	showExplorerBadge: true,
};

function randomId() {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function randomColor() {
	const palette = [
		"#e06c75",
		"#61afef",
		"#98c379",
		"#e5c07b",
		"#c678dd",
		"#56b6c2",
		"#d19a66",
	];
	return palette[Math.floor(Math.random() * palette.length)];
}

module.exports = class EditLockIndicatorPlugin extends Plugin {
	async onload() {
		// 사용자 식별 정보는 기기 로컬(localStorage)에서 로드 - 동기화 안 됨
		this.identity = this.loadIdentity();
		// 공용 동작 설정은 보관함(vault)에서 로드 - 동기화 됨 (문제 없음)
		await this.loadSettings();

		this.currentLocks = {}; // 메모리에 캐싱된 최신 잠금 상태
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("edit-lock-status");

		await this.ensureLockFile();

		// 설정 탭
		this.addSettingTab(new EditLockSettingTab(this.app, this));

		// 강제 잠금 해제 커맨드 (동료가 옵시디언을 비정상 종료했을 때 등 비상용)
		this.addCommand({
			id: "force-release-current-lock",
			name: "현재 파일 잠금 강제 해제",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.forceRelease(file.path);
				return true;
			},
		});

		// 파일을 열거나 / 레이아웃(탭)이 바뀔 때마다 즉시 한 번 동기화
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.syncLocks())
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.syncLocks())
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.updateAllUI()
			)
		);

		// 주기적으로(하트비트 겸 폴링) 잠금 정보를 읽고/갱신
		this.registerInterval(
			window.setInterval(
				() => this.syncLocks(),
				this.settings.tickSeconds * 1000
			)
		);

		this.app.workspace.onLayoutReady(() => this.syncLocks());
	}

	onunload() {
		// 플러그인이 꺼질 때 내가 들고 있던 잠금은 최대한 정리 시도
		// (비동기라 100% 보장되진 않음 - 안전망으로 staleSeconds 자동 만료가 있음)
		this.releaseAllOwnedLocksBestEffort();
		this.removeAllBanners();
	}

	async loadSettings() {
		const saved = (await this.loadData()) || {};
		// data.json에 예전 버전에서 남은 identity 필드가 있어도 무시한다
		// (혹시 남아있다면 다른 사용자와 동기화되어 있을 수 있는 값이므로 신뢰하지 않음)
		const { userId, userName, userColor, ...rest } = saved;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ---------------- 사용자 식별 정보 (기기 로컬 전용, 절대 보관함에 저장하지 않음) ----------------

	identityKey() {
		// 같은 컴퓨터에서 여러 보관함을 쓸 수 있으므로 보관함 이름을 키에 포함
		return `edit-lock-indicator:identity:${this.app.vault.getName()}`;
	}

	loadIdentity() {
		try {
			const raw = window.localStorage.getItem(this.identityKey());
			if (raw) {
				const parsed = JSON.parse(raw);
				if (parsed && parsed.userId) return parsed;
			}
		} catch (e) {
			/* localStorage 접근 실패 시 아래에서 새로 생성 */
		}
		const fresh = {
			userId: randomId(),
			userColor: randomColor(),
		};
		fresh.userName = "사용자-" + fresh.userId.slice(-4);
		this.persistIdentity(fresh);
		return fresh;
	}

	persistIdentity(identity) {
		try {
			window.localStorage.setItem(
				this.identityKey(),
				JSON.stringify(identity)
			);
		} catch (e) {
			console.error(
				"Edit Lock Indicator: 로컬 사용자 정보 저장 실패",
				e
			);
		}
	}

	saveIdentity() {
		this.persistIdentity(this.identity);
	}

	getLockPath() {
		return `${this.settings.lockFolder}/${this.settings.lockFileName}`;
	}

	async ensureLockFile() {
		const adapter = this.app.vault.adapter;
		try {
			const exists = await adapter.exists(this.settings.lockFolder);
			if (!exists) await adapter.mkdir(this.settings.lockFolder);
		} catch (e) {
			/* 폴더가 이미 있으면 무시 */
		}
		try {
			const exists = await adapter.exists(this.getLockPath());
			if (!exists) await adapter.write(this.getLockPath(), "{}");
		} catch (e) {
			console.error("Edit Lock Indicator: 잠금 파일 생성 실패", e);
		}
	}

	async readLocks() {
		try {
			const raw = await this.app.vault.adapter.read(
				this.getLockPath()
			);
			return JSON.parse(raw || "{}");
		} catch (e) {
			return {};
		}
	}

	async writeLocks(locks) {
		try {
			await this.app.vault.adapter.write(
				this.getLockPath(),
				JSON.stringify(locks, null, 2)
			);
		} catch (e) {
			console.error("Edit Lock Indicator: 잠금 파일 쓰기 실패", e);
		}
	}

	getOpenMarkdownPaths() {
		const paths = new Set();
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
			const file = leaf.view && leaf.view.file;
			if (file) paths.add(file.path);
		});
		return paths;
	}

	// 잠금 파일을 읽어서: 만료된 잠금 정리 -> 더 이상 안 열려있는 내 잠금 해제
	// -> 지금 열려있는 파일들 잠금 취득/갱신 -> 변경사항 있으면 저장 -> UI 갱신
	async syncLocks() {
		const now = Date.now();
		let locks = await this.readLocks();
		let changed = false;

		// 1) 만료된 잠금 제거 (staleSeconds 동안 갱신 안 된 것)
		for (const path of Object.keys(locks)) {
			if (now - locks[path].ts > this.settings.staleSeconds * 1000) {
				delete locks[path];
				changed = true;
			}
		}

		const openPaths = this.getOpenMarkdownPaths();

		// 2) 내가 잡고 있었지만 더 이상 열려있지 않은 파일 -> 잠금 해제
		for (const path of Object.keys(locks)) {
			if (
				locks[path].userId === this.identity.userId &&
				!openPaths.has(path)
			) {
				delete locks[path];
				changed = true;
			}
		}

		// 3) 현재 열려있는 파일들 -> 비어있거나 내 것이면 취득/갱신
		for (const path of openPaths) {
			const existing = locks[path];
			if (!existing || existing.userId === this.identity.userId) {
				locks[path] = {
					userId: this.identity.userId,
					userName: this.identity.userName,
					color: this.identity.userColor,
					ts: now,
				};
				changed = true;
			}
			// 다른 사용자의 유효한 잠금이면 손대지 않음
		}

		if (changed) await this.writeLocks(locks);

		this.currentLocks = locks;
		this.updateAllUI();
	}

	forceRelease(path) {
		this.readLocks().then((locks) => {
			if (locks[path]) {
				const wasOther = locks[path].userId !== this.identity.userId;
				delete locks[path];
				this.writeLocks(locks).then(() => {
					new Notice(
						wasOther
							? "다른 사용자의 잠금을 강제로 해제했습니다. (신중하게 사용하세요)"
							: "잠금을 해제했습니다."
					);
					this.syncLocks();
				});
			}
		});
	}

	releaseAllOwnedLocksBestEffort() {
		this.readLocks().then((locks) => {
			let changed = false;
			for (const path of Object.keys(locks)) {
				if (locks[path].userId === this.identity.userId) {
					delete locks[path];
					changed = true;
				}
			}
			if (changed) this.writeLocks(locks);
		});
	}

	// ---------------- UI ----------------

	updateAllUI() {
		this.updateStatusBar();
		this.updateBanners();
		if (this.settings.showExplorerBadge) this.updateExplorerBadges();
	}

	updateStatusBar() {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			this.statusBarEl.setText("");
			return;
		}
		const lock = this.currentLocks[file.path];
		if (!lock) {
			this.statusBarEl.setText("");
		} else if (lock.userId === this.identity.userId) {
			this.statusBarEl.setText("✏️ 편집 중 (나)");
		} else {
			this.statusBarEl.setText(`🔒 ${lock.userName}님이 편집 중`);
		}
	}

	updateBanners() {
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
			const view = leaf.view;
			const file = view && view.file;
			if (!file) return;
			const lock = this.currentLocks[file.path];
			const lockedByOther = lock && lock.userId !== this.identity.userId;

			const container = view.contentEl;
			let banner = container.querySelector(":scope > .edit-lock-banner");

			if (lockedByOther) {
				const minutesAgo = Math.max(
					0,
					Math.round((Date.now() - lock.ts) / 60000)
				);
				const timeText =
					minutesAgo <= 0 ? "방금 전" : `${minutesAgo}분 전`;
				if (!banner) {
					banner = container.createDiv({
						cls: "edit-lock-banner",
					});
					container.prepend(banner);
				}
				banner.style.borderLeftColor = lock.color || "#e06c75";
				banner.setText(
					`⚠️ 이 파일은 현재 "${lock.userName}"님이 편집 중입니다 (${timeText} 활동). 동시 편집 시 내용이 충돌할 수 있습니다.`
				);
			} else if (banner) {
				banner.remove();
			}
		});
	}

	removeAllBanners() {
		document
			.querySelectorAll(".edit-lock-banner")
			.forEach((el) => el.remove());
	}

	updateExplorerBadges() {
		const explorerLeaves = this.app.workspace.getLeavesOfType(
			"file-explorer"
		);
		explorerLeaves.forEach((leaf) => {
			const rootEl = leaf.view.containerEl;
			rootEl
				.querySelectorAll(".nav-file-title")
				.forEach((titleEl) => {
					const path = titleEl.getAttribute("data-path");
					if (!path) return;
					const lock = this.currentLocks[path];
					const lockedByOther =
						lock && lock.userId !== this.identity.userId;

					let badge = titleEl.querySelector(".edit-lock-badge");
					if (lockedByOther) {
						if (!badge) {
							badge = titleEl.createSpan({
								cls: "edit-lock-badge",
								text: "🔒",
							});
						}
						badge.title = `${lock.userName}님이 편집 중`;
					} else if (badge) {
						badge.remove();
					}
				});
		});
	}
};

class EditLockSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Edit Lock Indicator 설정" });

		containerEl.createEl("p", {
			text:
				"이 플러그인은 자체적으로 네트워크 통신을 하지 않습니다. " +
				"Syncthing, Google Drive, OneDrive, 네트워크 공유 폴더, Obsidian Sync 등 " +
				"기존에 사용 중인 동기화 수단으로 보관함이 공유되고 있어야 다른 사용자의 " +
				"편집 상태를 확인할 수 있습니다.",
			cls: "setting-item-description",
		});

		containerEl.createEl("p", {
			text:
				"아래 '내 표시 이름/색상'은 이 컴퓨터에만 저장됩니다(보관함에 저장되지 않음). " +
				"각 사용자는 자신의 컴퓨터에서 직접 자신의 이름을 설정해야 합니다.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("내 표시 이름")
			.setDesc(
				"다른 사용자에게 보여질 이름입니다. (이 기기에만 저장됨)"
			)
			.addText((text) =>
				text
					.setValue(this.plugin.identity.userName)
					.onChange((value) => {
						this.plugin.identity.userName =
							value.trim() || this.plugin.identity.userName;
						this.plugin.saveIdentity();
					})
			);

		new Setting(containerEl)
			.setName("내 표시 색상")
			.setDesc(
				"배너/배지에 표시될 색상입니다. (이 기기에만 저장됨)"
			)
			.addColorPicker((picker) =>
				picker
					.setValue(this.plugin.identity.userColor)
					.onChange((value) => {
						this.plugin.identity.userColor = value;
						this.plugin.saveIdentity();
					})
			);

		new Setting(containerEl)
			.setName("잠금 정보 저장 폴더")
			.setDesc(
				"보관함 내부에 잠금 정보(JSON)를 저장할 폴더입니다. 변경 후 재시작을 권장합니다."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.lockFolder)
					.onChange(async (value) => {
						this.plugin.settings.lockFolder =
							value.trim() || DEFAULT_SETTINGS.lockFolder;
						await this.plugin.saveSettings();
						await this.plugin.ensureLockFile();
					})
			);

		new Setting(containerEl)
			.setName("동기화 주기 (초)")
			.setDesc(
				"몇 초마다 잠금 정보를 읽고 갱신할지 설정합니다. 너무 짧으면 동기화 프로그램에 부담이 될 수 있습니다."
			)
			.addSlider((slider) =>
				slider
					.setLimits(3, 30, 1)
					.setValue(this.plugin.settings.tickSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.tickSeconds = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("잠금 만료 시간 (초)")
			.setDesc(
				"이 시간 동안 갱신이 없으면 비정상 종료 등으로 간주하여 잠금을 자동으로 해제합니다. 동기화 주기보다 3~5배 이상으로 설정하세요."
			)
			.addSlider((slider) =>
				slider
					.setLimits(10, 180, 5)
					.setValue(this.plugin.settings.staleSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.staleSeconds = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("파일 탐색기에 잠금 배지 표시")
			.setDesc("파일 목록에서 편집 중인 파일에 🔒 아이콘을 표시합니다.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showExplorerBadge)
					.onChange(async (value) => {
						this.plugin.settings.showExplorerBadge = value;
						await this.plugin.saveSettings();
						if (!value) {
							document
								.querySelectorAll(".edit-lock-badge")
								.forEach((el) => el.remove());
						}
					})
			);

		containerEl.createEl("h3", { text: "비상 조치" });
		new Setting(containerEl)
			.setName("현재 파일 잠금 강제 해제")
			.setDesc(
				"다른 사용자가 비정상 종료 등으로 잠금을 남겨둔 채 사라진 경우 사용하세요."
			)
			.addButton((btn) =>
				btn.setButtonText("강제 해제").onClick(() => {
					const file = this.app.workspace.getActiveFile();
					if (!file) {
						new Notice("현재 열려있는 파일이 없습니다.");
						return;
					}
					this.plugin.forceRelease(file.path);
				})
			);
	}
}
