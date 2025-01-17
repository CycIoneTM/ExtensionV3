import { imageHostToSrcset } from "./Image";

const BTTV_ZeroWidth = ["SoSnowy", "IceCold", "SantaHat", "TopHat", "ReinDeer", "CandyCane", "cvMask", "cvHazmat"];

export function convertTwitchEmoteSet(data: Twitch.TwitchEmoteSet): SevenTV.EmoteSet {
	return {
		id: "TWITCH#" + data.id,
		name: data.owner?.displayName ?? "Other emotes",
		immutable: true,
		privileged: true,
		tags: [],
		flags: 0,
		provider: "TWITCH",
		owner: data.owner?.displayName
			? {
					id: data.owner.id,
					username: data.owner.displayName,
					display_name: data.owner.displayName,
					avatar_url: data.owner.profileImageURL,
			  }
			: undefined,
		emotes: data.emotes.map((e) => {
			const d = convertTwitchEmote(e, data.owner);
			d.host.srcset = imageHostToSrcset(d.host, "TWITCH");
			return {
				id: e.id,
				name: e.token,
				flags: 0,
				provider: "TWITCH",
				data: d,
			};
		}),
	};
}

export function convertTwitchEmote(
	data: Partial<Twitch.TwitchEmote>,
	owner?: Twitch.TwitchEmoteSet["owner"],
): SevenTV.Emote {
	return {
		id: data.id ?? "",
		name: data.token ?? "",
		flags: 0,
		tags: [],
		lifecycle: 3,
		listed: true,
		owner: owner
			? {
					id: owner.id,
					username: owner.displayName,
					display_name: owner.displayName,
					avatar_url: owner.profileImageURL,
			  }
			: null,
		host: {
			url: "//static-cdn.jtvnw.net/emoticons/v2/" + data.id + "/default/dark",
			files: [
				{
					name: "1.0",
					format: "PNG",
				},
				{
					name: "2.0",
					format: "PNG",
				},
				{
					name: "3.0",
					format: "PNG",
				},
				{
					name: "4.0",
					format: "PNG",
				},
			],
		},
	};
}

export function convertCheerEmote(data: Twitch.ChatMessage.EmotePart["content"]): SevenTV.Emote {
	return {
		id: data.emoteID ?? "",
		name: `${data.alt} ${data.cheerAmount}`,
		flags: 0,
		tags: [],
		lifecycle: 3,
		listed: true,
		owner: null,
		host: {
			url: data.images?.dark["1x"].split("/").slice(0, -1).join("/").replace("https:", "") ?? "",
			files: [
				{
					name: "1.gif",
					format: "GIF",
				},
				{
					name: "2.gif",
					format: "GIF",
				},
				{
					name: "3.gif",
					format: "GIF",
				},
				{
					name: "4.gif",
					format: "GIF",
				},
			],
		},
	};
}

export function convertBttvEmoteSet(data: BTTV.UserResponse, channelID: string): SevenTV.EmoteSet {
	const channelEmotes = data.channelEmotes ?? [];
	const sharedEmotes = data.sharedEmotes ?? [];

	return {
		id: "BTTV#" + channelID,
		name: channelID == "GLOBAL" ? "Global emotes" : "Channel emotes",
		immutable: true,
		privileged: true,
		tags: [],
		flags: 0,
		provider: "BTTV",
		owner: {
			id: channelID,
			username: channelID,
			display_name: channelID,
			avatar_url: data.avatar ?? "",
		},
		emotes: [...channelEmotes, ...sharedEmotes].map((e) => {
			const data = convertBttvEmote(e);
			data.host.srcset = imageHostToSrcset(data.host, "BTTV");
			return {
				id: e.id,
				name: e.code,
				flags: 0,
				provider: "BTTV",
				data: data,
			};
		}),
	};
}

export function convertBttvEmote(data: BTTV.Emote): SevenTV.Emote {
	return {
		id: data.id,
		name: data.code,
		flags: BTTV_ZeroWidth.indexOf(data.code) > -1 ? 256 : 0,
		tags: [],
		lifecycle: 3,
		listed: true,
		owner: data.user
			? {
					id: data.user.id,
					username: data.user.name,
					display_name: data.user.displayName,
					avatar_url: "",
			  }
			: null,
		host: {
			url: "//cdn.betterttv.net/emote/" + data.id,
			files: [
				{
					name: "1x",
					format: data.imageType.toUpperCase() as SevenTV.ImageFormat,
				},
				{
					name: "2x",
					format: data.imageType.toUpperCase() as SevenTV.ImageFormat,
				},
				{
					name: "3x",
					format: data.imageType.toUpperCase() as SevenTV.ImageFormat,
				},
			],
		},
	};
}

export function convertFFZEmoteSet(data: FFZ.RoomResponse, channelID: string): SevenTV.EmoteSet {
	const sets = Object.values(data.sets);

	return {
		id: "FFZ#" + channelID,
		name: channelID == "GLOBAL" ? " Global emotes" : "Channel emotes",
		immutable: true,
		privileged: true,
		tags: [],
		flags: 0,
		provider: "FFZ",
		owner: {
			id: channelID,
			username: channelID,
			display_name: channelID,
			avatar_url: "",
		},
		emotes: sets.length
			? sets.reduce((con, set) => {
					return [
						...con,
						...(set.emoticons.map((e) => {
							const data = convertFFZEmote(e);
							data.host.srcset = imageHostToSrcset(data.host, "FFZ");
							return {
								id: e.id.toString(),
								name: e.name,
								flags: 0,
								provider: "FFZ",
								data: data,
							};
						}) as SevenTV.ActiveEmote[]),
					];
			  }, [] as SevenTV.ActiveEmote[])
			: [],
	};
}

export function convertFFZEmote(data: FFZ.Emote): SevenTV.Emote {
	return {
		id: data.id.toString(),
		name: data.name,
		flags: 0,
		tags: [],
		lifecycle: 3,
		listed: true,
		owner: null,
		host: {
			url: "//cdn.frankerfacez.com/emote/" + data.id,
			files: Object.keys(data.urls).map((key) => {
				return {
					name: key,
					format: "PNG",
				};
			}),
		},
	};
}

export function convertSeventvOldCosmetics(
	data: SevenTV.OldCosmeticsResponse,
): [SevenTV.Cosmetic<"BADGE">[], SevenTV.Cosmetic<"PAINT">[]] {
	const badges = [] as SevenTV.Cosmetic<"BADGE">[];
	const paints = [] as SevenTV.Cosmetic<"PAINT">[];

	for (const badge of data.badges) {
		badges.push({
			id: badge.id,
			kind: "BADGE",
			name: badge.name,
			user_ids: badge.users,
			data: {
				tooltip: badge.tooltip,
				host: {
					url: "//cdn.7tv.app/badge/" + badge.id,
					files: [{ name: "1x" }, { name: "2x" }, { name: "3x" }],
				},
			},
		} as SevenTV.Cosmetic<"BADGE">);
	}

	for (const paint of data.paints) {
		paints.push({
			id: paint.id,
			kind: "PAINT",
			name: paint.name,
			user_ids: paint.users,
			data: {
				angle: paint.angle,
				color: paint.color,
				function: paint.function.replace("-", "_").toUpperCase(),
				image_url: paint.image_url ?? null,
				repeat: paint.repeat ?? false,
				shadows: paint.drop_shadows ?? [],
				shape: paint.shape ?? null,
				stops: paint.stops ?? [],
			},
		} as SevenTV.Cosmetic<"PAINT">);
	}

	return [badges, paints];
}
