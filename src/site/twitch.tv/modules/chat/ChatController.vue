<template>
	<Teleport v-if="channel && channel.id" :to="containerEl">
		<UiScrollable ref="scroller" @container-scroll="onScroll" @container-wheel="onWheel">
			<div id="seventv-message-container" class="seventv-message-container">
				<ChatList :messages="messages" :controller="controller.component" />
			</div>
		</UiScrollable>

		<!-- Data Logic -->
		<ChatData />

		<!-- New Messages during Scrolling Pause -->
		<div
			v-if="scrollPaused && pauseBuffer.length > 0"
			class="seventv-message-buffer-notice"
			@click="unpauseScrolling"
		>
			<span>{{ pauseBuffer.length }}{{ pauseBuffer.length >= lineLimit ? "+" : "" }} new messages</span>
		</div>
	</Teleport>

	<ChatTray />
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, toRefs, watch, watchEffect } from "vue";
import { refDebounced, until, useTimeout, useTimeoutFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { useStore } from "@/store/main";
import { ObserverPromise } from "@/common/Async";
import { log } from "@/common/Logger";
import { getRandomInt } from "@/common/Rand";
import { HookedInstance, awaitComponents } from "@/common/ReactHooks";
import { defineFunctionHook, definePropertyHook, unsetPropertyHook } from "@/common/Reflection";
import { useChatContext } from "@/composable/chat/useChatContext";
import { useChatEmotes } from "@/composable/chat/useChatEmotes";
import { useChatMessages } from "@/composable/chat/useChatMessages";
import { useChatProperties } from "@/composable/chat/useChatProperties";
import { useChatScroller } from "@/composable/chat/useChatScroller";
import { tools } from "@/composable/useCardOpeners";
import { useWorker } from "@/composable/useWorker";
import { MessageType, ModerationType } from "@/site/twitch.tv";
import ChatData from "@/site/twitch.tv/modules/chat/ChatData.vue";
import ChatList from "@/site/twitch.tv/modules/chat/ChatList.vue";
import ChatTray from "./ChatTray.vue";
import UiScrollable from "@/ui/UiScrollable.vue";

const props = defineProps<{
	list: HookedInstance<Twitch.ChatListComponent>;
	controller: HookedInstance<Twitch.ChatControllerComponent>;
	room: HookedInstance<Twitch.ChatRoomComponent>;
}>();

const store = useStore();
const { channel } = storeToRefs(store);
const { sendMessage: sendWorkerMessage } = useWorker();

const { list, controller, room } = toRefs(props);

const el = document.createElement("seventv-container");
el.id = "seventv-chat-controller";

const containerEl = ref<HTMLElement>(el);
const replacedEl = ref<Element | null>(null);

const bounds = ref<DOMRect>(el.getBoundingClientRect());
const scroller = ref<InstanceType<typeof UiScrollable> | undefined>();

watch(channel, (channel) => {
	if (!channel) {
		return;
	}

	log.info("<ChatController>", `Joining #${channel.username}`);
});

const {
	lineLimit,
	paused: scrollPaused,
	onScroll,
	onWheel,
	unpause: unpauseScrolling,
	scrollToLive,
} = useChatScroller({
	scroller: scroller,
	bounds: bounds,
});
const { channel: currentChatChannel } = useChatContext();
const {
	addMessage,
	messages,
	pauseBuffer,
	clear,
	messageHandlers,
	find: findMessages,
	messagesByUser,
	setMessageSender,
	chatters,
} = useChatMessages();
const {
	twitchBadgeSets,
	primaryColorHex,
	useHighContrastColors,
	showTimestamps,
	showModerationIcons,
	isModerator,
	isVIP,
	isDarkTheme,
	blockedUsers,
} = useChatProperties();
const { resetProviders } = useChatEmotes();

const dataSets = reactive({
	badges: false,
});

// Defines the current channel for hooking
const currentChannel = ref<CurrentChannel | null>(null);

// Capture the chat root node
watchEffect(() => {
	if (!list.value.domNodes) return;

	const rootNode = list.value.domNodes.root;
	if (!rootNode) return;

	rootNode.classList.add("seventv-chat-list");

	containerEl.value = rootNode as HTMLElement;
});

// Update current channel globally
function onUpdateChannel() {
	if (!store.setChannel(currentChannel.value)) return;

	hookMessageBuffer();

	clear();
	resetProviders();
}

// The message handler is hooked to render messages and prevent
// the native twitch renderer from rendering them
const messageHandler = ref<Twitch.MessageHandlerAPI | null>(null);

watch(
	messageHandler,
	(handler, old) => {
		if (handler !== old && old) {
			unsetPropertyHook(old, "handleMessage");
		} else if (handler) {
			defineFunctionHook(handler, "handleMessage", function (old, msg: Twitch.AnyMessage) {
				const t = Date.now() + getRandomInt(0, 1000);
				const msgData = Object.create({ seventv: true, t });
				for (const k of Object.keys(msg)) {
					msgData[k] = msg[k as keyof Twitch.AnyMessage];
				}

				const ok = onMessage(msgData);
				if (ok) return ""; // message was rendered by the extension

				// message was not rendered by the extension
				return old?.call(this, msg);
			});
		}
	},
	{ immediate: true },
);

// Keep track of props
definePropertyHook(list.value.component, "props", {
	value(v) {
		messageHandler.value = v.messageHandlerAPI;

		if (!dataSets.badges) {
			// Find message to grab some data
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const msgItem = (v.children[0] as any | undefined)?.props as Twitch.ChatLineComponent["props"];
			if (!msgItem?.badgeSets?.count) return;

			twitchBadgeSets.value = msgItem.badgeSets;

			dataSets.badges = true;
		}
	},
});

// Retrieve and convert Twitch Emotes
//
// This processed is deferred to the worker asynchronously
// in order to reduce the load on the main thread.
const twitchEmoteSets = ref<Twitch.TwitchEmoteSet[]>([]);
const twitchEmoteSetsDbc = refDebounced(twitchEmoteSets, 1000);
watch(twitchEmoteSetsDbc, async (sets) => {
	if (!sets.length) return;

	for (const set of twitchEmoteSets.value) {
		await until(useTimeout(25)).toBeTruthy();
		sendWorkerMessage("SYNC_TWITCH_SET", { input: set });
	}
});

// Keep track of user chat config
definePropertyHook(room.value.component, "props", {
	value(v) {
		primaryColorHex.value = v.primaryColorHex;
		useHighContrastColors.value = v.useHighContrastColors;
		showTimestamps.value = v.showTimestamps;
		showModerationIcons.value = v.showModerationIcons;
	},
});

// Keep track of chat state
definePropertyHook(controller.value.component, "props", {
	value(v: typeof controller.value.component.props) {
		if (v.channelID) {
			currentChannel.value = {
				id: v.channelID,
				username: v.channelLogin,
				display_name: v.channelDisplayName,
				loaded: false,
			};

			currentChatChannel.value = currentChannel.value;
			onUpdateChannel();
		}

		// Keep track of chat props
		isModerator.value = v.isCurrentUserModerator;
		isVIP.value = v.isCurrentUserVIP;
		isDarkTheme.value = v.theme;
		setMessageSender(v.chatConnectionAPI.sendMessage);

		// Parse twitch emote sets
		const data = v.emoteSetsData;
		if (!data || !data.emoteSets || data.loading) return;

		twitchEmoteSets.value = data.emoteSets;

		// Add the current user & channel owner to active chatters
		if (v.userID) {
			chatters.value[v.userID] = {};
			chatters.value[v.channelID] = {};
		}
	},
});

// Determine if the message should performe some action or be sendt to the chatAPI for rendering
const onMessage = (msg: Twitch.AnyMessage): boolean => {
	msg.channelID = channel.value?.id ?? "";

	switch (msg.type) {
		case MessageType.MESSAGE:
		case MessageType.SUBSCRIPTION:
		case MessageType.RESUBSCRIPTION:
		case MessageType.SUB_GIFT:
		case MessageType.RAID:
		case MessageType.SUB_MYSTERY_GIFT:
		case MessageType.CHANNEL_POINTS_REWARD:
		case MessageType.ANNOUNCEMENT_MESSAGE:
			onChatMessage(msg as Twitch.DisplayableMessage);
			break;
		case MessageType.MODERATION:
			onModerationMessage(msg as Twitch.ModerationMessage);
			break;
		case MessageType.MESSAGE_ID_UPDATE:
			onMessageIdUpdate(msg as Twitch.IDUpdateMessage);
			break;
		default:
			return false;
	}

	//Send message to our registered message handlers
	messageHandlers.value.forEach((h) => h(msg));
	return true;
};

function onChatMessage(msg: Twitch.DisplayableMessage) {
	// If the message is from a blocked user and we are not moderator
	if (!isModerator.value && msg.user && blockedUsers.value.has(msg.user.userID)) {
		return;
	}

	// The message is our own if it has a nonce
	if (msg.nonce) {
		const msgRef = ref(msg);

		// Set the message to a sending state
		msgRef.value.sendState = "sending";

		// Set a timeout, beyond which we'll consider the message failed to send
		const { stop } = useTimeoutFn(() => {
			msgRef.value.sendState = "failed";
		}, 10e3);

		msgRef.value.notifySent = stop;
	}

	// Add message to store
	// it will be rendered on the next tick
	addMessage(msg);
}

function onModerationMessage(msg: Twitch.ModerationMessage) {
	if (msg.moderationType == ModerationType.DELETE) {
		const found = findMessages((m) => m.id == msg.targetMessageID);
		if (found) {
			if (found.deleted !== undefined) found.deleted = true;
			if (found.message?.deleted !== undefined) found.message.deleted = true;
		}
	} else {
		const messages = messagesByUser(msg.userLogin);
		for (const m of messages) {
			if (!m.seventv || m.user?.userLogin != msg.userLogin) continue;
			if (m.banned !== undefined) m.banned = true;
			if (m.message?.banned !== undefined) m.message.banned = true;
		}
	}
}

function onMessageIdUpdate(msg: Twitch.IDUpdateMessage) {
	const found = findMessages((m) => m.nonce == msg.nonce);
	if (found) {
		found.id = msg.id;
		found.sendState = "sent";
		found.notifySent?.();
	}
}

const a = awaitComponents<Twitch.ViewerCardComponent>({
	parentSelector: ".stream-chat",
	predicate: (n) => n.onShowViewerCard && n.onShowExtensionMessageCard,
});

a.then(
	([c]) => {
		if (!c) return;
		tools.onShowViewerCard = c.onShowViewerCard;
		tools.onShowEmoteCard = c.onShowEmoteCard;
		tools.setViewerCardPage = c.setViewerCardPage;
	},
	() => null,
);

if (a instanceof ObserverPromise) {
	until(useTimeout(10e3))
		.toBeTruthy()
		.then(() => a.disconnect());
}

// Keep track of unhandled nodes
const nodeMap = new Map<string, Element>();

let unhandledStopper: () => void;
function watchUnhandled() {
	if (unhandledStopper) unhandledStopper();

	// Watch for updated dom nodes on unhandled message components
	unhandledStopper = watch(list.value.domNodes, (nodes) => {
		const missingIds = new Set<string>(nodeMap.keys()); // ids of messages that are no longer rendered

		for (const [nodeId, node] of Object.entries(nodes)) {
			if (nodeId === "root") continue;
			missingIds.delete(nodeId);

			if (nodeMap.has(nodeId)) continue;

			addMessage({
				id: nodeId + "-unhandled",
				element: node,
			} as Twitch.DisplayableMessage);

			nodeMap.set(nodeId, node);
		}

		for (const nodeId of missingIds) {
			nodeMap.delete(nodeId);
		}
	});
}

const messageBufferComponent = ref<Twitch.MessageBufferComponent | null>(null);
const messageBufferComponentDbc = refDebounced(messageBufferComponent, 200);

watch(messageBufferComponentDbc, (msgBuf, old) => {
	if (old && msgBuf !== old) {
		unsetPropertyHook(old, "buffer");
		unsetPropertyHook(old, "blockedUsers");
	} else if (msgBuf) {
		definePropertyHook(msgBuf, "buffer", {
			value(buffer) {
				// Wait until historical messages have loaded
				if (msgBuf.props.isLoadingHistoricalMessages) return;

				const historical = [] as Twitch.DisplayableMessage[];

				for (const msg of buffer) {
					// If the message is historical we add it to the array and continue
					if ((msg as Twitch.ChatMessage).isHistorical) {
						historical.push(msg);
						nodeMap.set(msg.id, {} as Element);
						continue;
					}

					if (onMessage(msg)) nodeMap.set(msg.id, {} as Element);
				}

				messages.value = historical.concat(messages.value);

				watchUnhandled();

				nextTick(() => {
					// Instantly scroll to the bottom and stop hooking the buffer
					scrollToLive(0);
					unsetPropertyHook(msgBuf, "buffer");
				});
			},
		});
		definePropertyHook(msgBuf, "blockedUsers", {
			value(users) {
				blockedUsers.value = users;
			},
		});
	}
});

async function hookMessageBuffer() {
	const result = awaitComponents<Twitch.MessageBufferComponent>({
		parentSelector: ".stream-chat",
		predicate: (n) => n.prependHistoricalMessages && n.buffer && n.blockedUsers,
	}).then(
		([i]) => {
			if (!i) return;

			messageBufferComponent.value = i;
		},
		() => watchUnhandled(),
	);

	if (result instanceof ObserverPromise) {
		until(useTimeout(10e3))
			.toBeTruthy()
			.then(() => result.disconnect());
	}
}

// Apply new boundaries when the window is resized
const resizeObserver = new ResizeObserver(() => {
	bounds.value = containerEl.value.getBoundingClientRect();
});
resizeObserver.observe(containerEl.value);

onUnmounted(() => {
	resizeObserver.disconnect();

	el.remove();
	if (replacedEl.value) replacedEl.value.classList.remove("seventv-checked");

	log.debug("<ChatController> Unmounted");

	// Unset hooks
	unsetPropertyHook(list.value.component.props, "messageHandlerAPI");
	unsetPropertyHook(list.value.component, "props");
	unsetPropertyHook(controller.value.component, "props");
	unsetPropertyHook(room.value.component, "props");
});

const primaryColor = computed(() => `#${primaryColorHex.value ?? "755ebc"}`);
</script>

<style lang="scss">
seventv-container.seventv-chat-list {
	display: flex;
	flex-direction: column !important;
	-webkit-box-flex: 1 !important;
	flex-grow: 1 !important;
	overflow: auto !important;
	overflow-x: hidden !important;

	> seventv-container {
		display: none;
	}

	.seventv-message-container {
		line-height: 1.5em;

		--seventv-primary-color: v-bind(primaryColor);
	}

	// Chat padding
	&.custom-scrollbar {
		scrollbar-width: none;

		&::-webkit-scrollbar {
			width: 0;
			height: 0;
		}

		.seventv-scrollbar {
			$width: 1em;

			position: absolute;
			right: 0;
			width: $width;
			overflow: hidden;
			border-radius: 0.33em;
			background-color: black;

			> .seventv-scrollbar-thumb {
				position: absolute;
				width: 100%;

				background-color: rgb(77, 77, 77);
			}
		}
	}

	.seventv-message-buffer-notice {
		cursor: pointer;
		position: absolute;
		bottom: 8em;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.5em;
		border-radius: 0.33em;
		color: #fff;
		background-color: rgba(0, 0, 0, 50%);
		backdrop-filter: blur(0.05em);
	}
}

.community-highlight {
	background-color: var(--seventv-background-transparent-1) !important;
	backdrop-filter: blur(1em);
	transition: background-color 0.25s;

	&:hover {
		opacity: 1;
	}
}

.chat-list--default.seventv-checked {
	display: none !important;
}
</style>
