
import { Devvit, type FormField, Post, Comment, RedditAPIClient, SettingScope, SubredditData, SubredditInfo, ModeratorPermission, User, ModNote, JobContext, TriggerContext } from "@devvit/public-api";
import { getAppSettings } from "./main.js";
import { differenceInDays, differenceInHours, Duration, formatDistanceToNow, formatDuration, intervalToDuration } from "date-fns";

Devvit.configure({
  redditAPI: true,
});

export const MAX_COMMENT_CHARACTER_COUNT = 10000 as number;

export type RedditPlatform =
  | 'ios'
  | 'android'
  | 'shreddit'
  | 'newreddit'
  | 'oldreddit'
  | 'web'
  | 'app'
  | 'unknown';

/**
 * Returns a detailed platform ID based on the devvit-user-agent metadata.
 * Useful for tailoring URLs or UI behaviors per platform.
 */
export function getRedditPlatform(context: Devvit.Context): RedditPlatform {
  const ua = context.metadata?.['devvit-user-agent']?.values?.[0]?.toLowerCase() ?? '';

  // --- Mobile app detection ---
  if (ua.includes('ios')) return 'ios';
  if (ua.includes('shreddit')) return 'shreddit';
  if (ua.includes('android')) return 'android';

  // --- Web detection ---
  if (ua.includes('newreddit')) return 'newreddit';
  if (ua.includes('oldreddit')) return 'oldreddit';
  if (ua.includes('web')) return 'web';

  return 'unknown';
}

/**
 * Returns a simplified category:
 *  - "app" for iOS / Android / Shreddit
 *  - "web" for new / old Reddit
 */
export function getRedditPlatformGroup(context: Devvit.Context): 'app' | 'web' | 'unknown' {
  const platform = getRedditPlatform(context);
  if (['ios', 'android'].includes(platform)) return 'app';
  if (['shreddit', 'newreddit', 'oldreddit', 'web'].includes(platform)) return 'web';
  return 'unknown';
}

export function isRedditApp(context: Devvit.Context): boolean {
    return getRedditPlatformGroup(context) === 'app';
}

/**
 * Compare app versions to see if a newer version is available.
 * @param newVersion - Version string to compare against (e.g., "1.2.3")
 * @param context - Devvit context to access app info
 * @returns true if the current app version is lower than newVersion
 */
export async function isNewerVersionAvailable(context: Devvit.Context | JobContext, newVersion: string): Promise<boolean> {
  // Get the current app version from the manifest
  const currentVersion = context.appVersion; // e.g., "1.2.0"

  const parseVersion = (v: string) => v.split('.').map(p => Number(p.replace(/\D.*$/, '')) || 0);

  const [currMajor, currMinor, currPatch] = parseVersion(currentVersion);
  const [newMajor, newMinor, newPatch] = parseVersion(newVersion);

  if (newMajor > currMajor) return true;
  if (newMajor === currMajor && newMinor > currMinor) return true;
  if (newMajor === currMajor && newMinor === currMinor && newPatch > currPatch) return true;

  return false; // current version is equal or newer
}

/**
 * Returns the correct Reddit domain for the detected platform.
 */
export function formatRedditUrl(context: Devvit.Context, url: string): string {
  //const platform = getRedditPlatform(context);
  const group = getRedditPlatformGroup(context);

  //TODO if we can ever tell if user is opted into new Reddit or not, handle old vs sh vs www domains

  switch (group) {
    case 'app':
     //return 'https://reddit.app.link/?reddit_url=' + encodeURIComponent(url);
    default:
      // Fallback to normal Reddit
      return url;
  }
}

/**
 * Check mod permissions
 */
export async function getModPerms(context: Devvit.Context | TriggerContext, username?: string) : Promise<ModeratorPermission[]> {
    const subredditName = await context.reddit.getCurrentSubredditName() || '';
    username = username ? username : await context.reddit.getCurrentUsername() || '';
    const listing = context.reddit.getModerators({ subredditName });
    const mods = await listing.all(); // <-- convert Listing<User> to User[]
    const mod = mods.find(m => m.username.toLowerCase() === username.toLowerCase());
    const perms = mod ? await mod.getModPermissionsForSubreddit(subredditName) : [];
    return perms;
}

export async function checkForModPerms(context: Devvit.Context | TriggerContext, requiredPerms : ModeratorPermission[], username?: string) : Promise<boolean> {
    const perms = await getModPerms(context, username);
    // If the user has "all", they automatically pass.
    if (perms.includes('all')) return true;

    // Otherwise, check if every required permission is present.
    return requiredPerms.every(p => perms.includes(p));
}

/**
 * Returns Reddit account age using the largest non-zero unit (e.g., "2 years" or "5 days").
 * @param userOrUsername Either a username string or a Reddit User object
 * @param reddit Reddit API client
 * @returns Object with { ageMs, ageText }
 */
export async function getRedditAccountAgeInfo(
	userOrUsername: string | User,
	reddit: any
): Promise<{ ageMs: number; ageText: string }> {
    let accountAge: string;
	let user: User;

	// Fetch user if string provided
	if (typeof userOrUsername === 'string') {
		user = await reddit.getUserByUsername(userOrUsername);
		if (!user) throw new Error(`User "${userOrUsername}" not found`);
	} else {
		user = userOrUsername;
	}

	accountAge = formatDistanceToNow(user.createdAt);
	// const units: (keyof Duration)[] = ["years", "months", "days"];
	// if (differenceInDays(new Date(), user.createdAt) < 2) {
	// 	units.push("hours");
	// }
	// if (differenceInHours(new Date(), user.createdAt) < 6) {
	// 	units.push("minutes");
	// }
	// const duration = intervalToDuration({ start: user.createdAt, end: new Date() });
	// accountAge = formatDuration(duration, { format: units });

	const now = new Date();
	const ageMs = now.getTime() - user.createdAt.getTime();

    return {ageMs, ageText: accountAge};
}

//
// ──────────────────────────────────────────────────────────────
//   Type Definitions
// ──────────────────────────────────────────────────────────────
//

interface CachedNote {
	id: string;
	label: string;
	text: string;
	displayText: string;
	createdAt: string;
}

export interface AuthorBreakdownCache {
	username: string;
	removals: number;
	bans: number;
	mutes: number;
	lastCheckedAt: string; // ISO string
	userNotes: CachedNote[];

	// Track final state per content ID (REMOVAL, SPAM, APPROVAL, etc.)
	finalStateByContent: Record<string, string>;
}

// Map mod-note labels to emoji (fall back to ⍰ for unknown labels)
const modNoteLabelEmojiMap: Record<string,string> = {
	"HELPFUL_USER": "🙌",
	"SOLID_CONTRIBUTOR": "✅",
	"SPAM_WATCH": "👀",
	"SPAM_WARNING": "⚠️",
	"ABUSE_WARNING": "❗",
	"BAN": "🚫",
	"PERMA_BAN": "⛔",
	"BOT_BAN": "🤖🚫"
};

//
// ──────────────────────────────────────────────────────────────
//   Helper Functions for Redis Storage
// ──────────────────────────────────────────────────────────────
//

export async function getLastAuthorBreakdown(context: Devvit.Context, username: string): Promise<AuthorBreakdownCache | null> {
	const key = `authorBreakdown:${username}`;
	const value = await context.redis.get(key);
	if (!value) return null;
	try {
		return JSON.parse(value) as AuthorBreakdownCache;
	} catch {
		return null;
	}
}

export async function setLastAuthorBreakdown(
    context: Devvit.Context,
    username: string,
    breakdown: AuthorBreakdownCache
    ): Promise<void> {
    const key = `authorBreakdown:${username}`;

    // Save the breakdown data
    await context.redis.set(key, JSON.stringify(breakdown));

    // Maintain a list of cached keys in a single JSON array
    const listKey = "authorBreakdownKeys";
    const existing = await context.redis.get(listKey);
    const keys = existing ? JSON.parse(existing) as string[] : [];

    if (!keys.includes(key)) {
        keys.push(key);
        await context.redis.set(listKey, JSON.stringify(keys));
    }
}


export async function clearAllAuthorBreakdownKeys(context: Devvit.Context, username: string): Promise<void> {
	const key = `authorBreakdown:${username}`;
	await context.redis.del(key);
	console.log(`[Author Breakdown] Cleared cache for ${username}`);
}

//
// ──────────────────────────────────────────────────────────────
//   Main Breakdown Function
// ──────────────────────────────────────────────────────────────
//

export async function getAuthorBreakdown(
	context: Devvit.Context,
	username: string,
	detailed: boolean = false
): Promise<string> {
	console.log(`[DEBUG] Starting author breakdown for ${username}`);
	let cache = await getLastAuthorBreakdown(context, username);

	const settings = await getAppSettings(context);

	// ──────────────────────────────────────────────
	// Fetch mod notes safely
	// ──────────────────────────────────────────────
	let modNotes: ModNote[] = [];
	try {
		modNotes = await context.reddit.getModNotes({
			subreddit: context.subredditName ?? '',
			user: username
		}).all();
		//console.log(`[DEBUG] Retrieved ${modNotes.length} mod notes for ${username}`);
	} catch (err) {
		console.error(`[ERROR] Failed to fetch mod notes for ${username}:`, err);
		modNotes = [];
	}

	// Sort ascending for incremental updates
	modNotes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

	const newNotes: CachedNote[] = [];
	let userNotes = cache?.userNotes ?? [];
	let lastCheckedAt = cache?.lastCheckedAt ? new Date(cache.lastCheckedAt) : new Date(0);

	// Track final state per content ID
	const finalStateByContent: Record<string, string> = cache?.finalStateByContent ?? {};

	for (const note of modNotes) {
		if (note.createdAt <= lastCheckedAt) continue;

		const contentId = note.modAction?.target?.id ?? note.id;
        //log("\n----------------------------------\nnote.modAction: " + note.modAction + "\note.modAction?.target: " + note.modAction?.target + "\note.modAction?.target?.id: " + note.modAction?.target?.id);
		const modType = note.modAction?.type?.toUpperCase?.() ?? note.type?.toUpperCase?.() ?? 'UNKNOWN';
		// Save the latest mod action for this content
		finalStateByContent[contentId] = modType;

		//console.log(`[DEBUG] Note ${note.id} | type=${modType} | contentId=${contentId}`);

		// Handle user notes
		if (modType === 'NOTE' && note.userNote?.note) {
			const label = note.userNote?.label ?? '';
			const rawText = note.userNote?.note ?? '(no text)';
			const emoji = modNoteLabelEmojiMap[label] ?? '';
			const displayPrefix = emoji ? `${emoji} ` : (label ? '⍰ ' : '');
			const displayText = `${displayPrefix}${rawText}`;

			newNotes.push({
				id: note.id,
				label,
				text: rawText,
				displayText,
				createdAt: note.createdAt.toISOString()
			});
		}
	}

	// ──────────────────────────────────────────────
	// Compute totals based on final state per content
	// ──────────────────────────────────────────────
	let removals = 0;
	let bans = 0;
	let mutes = 0;

	for (const contentId in finalStateByContent) {
		const modType = finalStateByContent[contentId];
		if (modType === 'SPAM' || modType === 'REMOVE' || modType === 'REMOVAL') {
			removals++;
		} else if (modType === 'BAN') {
			bans++;
		} else if (modType === 'MUTE') {
			mutes++;
		}
	}

	// Merge old + new user notes and sort newest → oldest
	const mergedNotes = [...userNotes, ...newNotes]
		.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i)
		.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
		.slice(0, 200);

	// Save updated cache
	const newCache: AuthorBreakdownCache = {
		username,
		removals,
		bans,
		mutes,
		lastCheckedAt: new Date().toISOString(),
		userNotes: mergedNotes,
		finalStateByContent
	};

	await setLastAuthorBreakdown(context, username, newCache);
	//console.log(`[DEBUG] Cache updated for ${username}: R=${removals}, B=${bans}, M=${mutes}`);

	// ──────────────────────────────────────────────
	// Build Output
	// ──────────────────────────────────────────────
	const repeatEmoji =
		(removals >= settings.repeatOffenderRemovalThreshold ||
			bans >= settings.repeatOffenderBanThreshold ||
			mutes >= settings.repeatOffenderMuteThreshold)
			? "⚠️ "
			: "";

	const latestUserNote = mergedNotes[0];
	let latestNoteText = latestUserNote
		? `${latestUserNote.displayText ? `${latestUserNote.displayText} ` : ''}`
		: '';

	const user = await context.reddit.getUserByUsername(username);
	let { ageMs, ageText } = await getRedditAccountAgeInfo('username', context.reddit);
	const commentKarma = user?.commentKarma;
	const karmaAlert = commentKarma && commentKarma < 0;

    let uniqueDomains, socialMediaDomains = undefined;
    const socialLinks = await user?.getSocialLinks();
	if (socialLinks && socialLinks.length > 0) {
		const domains = socialLinks
			.map(link => getMainDomain(link.outboundUrl))
			.filter((d): d is string => d !== null);

		uniqueDomains = Array.from(new Set(domains));
        socialMediaDomains = (await getAppSettings(context)).socialMedialFlaggedDomains
            ?.split(',')
            .map(d => d.trim().toLowerCase())
            .filter(Boolean)
            ?? [];
	}

	const maxNewUserAgeDays = 60; //TODO make this a setting?
	if (!detailed) {
		let baseLine = `${repeatEmoji}u/${username} | Removals: ${removals} | Bans: ${bans} | Mutes: ${mutes}`;
		let parenthesisInsert = undefined;
		if (karmaAlert) {
			if (!baseLine.startsWith('⚠️')) baseLine = '⚠️' + baseLine;
			parenthesisInsert = ' (' + commentKarma + ' comment karma) | ';
		}
		if (ageMs < maxNewUserAgeDays * 24 * 60 * 60 * 1000) {
			if (baseLine.startsWith('⚠️')) baseLine = baseLine.replace('⚠️', '⚠️ 🆕');
			else baseLine = '🆕 ' + baseLine;
			if (parenthesisInsert) parenthesisInsert = parenthesisInsert.replace('comment karma)', 'comment karma, ' + ageText + ')');
			else parenthesisInsert = ' (' + ageText + ') | ';
		}
		if (parenthesisInsert) baseLine = baseLine.replace(' | ', parenthesisInsert);

        if (socialLinks && socialLinks.length > 0 && uniqueDomains && uniqueDomains.some(domain => socialMediaDomains && socialMediaDomains.includes(domain.toLowerCase()))) {
            const matchedDomains = uniqueDomains
                .map(d => d.toLowerCase())
                .filter(domain => socialMediaDomains && socialMediaDomains.includes(domain));

            const matchedDomainsString = matchedDomains.join(', ');
            baseLine += ' | ⚠️ Profile Link(s) Include: ' + matchedDomainsString;
        }

		return latestNoteText ? `${baseLine} | ${latestNoteText}` : baseLine;
	}

	// Detailed multi-line view
	ageText = (ageMs < maxNewUserAgeDays * 24 * 60 * 60 * 1000 ? '🆕 ' : '') + ageText;
	const postKarma = user?.linkKarma;
	const nsfw = user?.nsfw;
	let details = `u/${username}${nsfw ? ' 🔞' : ''} (${ageText}) - ${(karmaAlert ? '⚠️ ' : '')}${postKarma} post | ${commentKarma} comment\n\n`;
	details += `${repeatEmoji}Removals: ${removals} | Bans: ${bans} | Mutes: ${mutes}\n\n`;

	if (socialLinks && socialLinks.length > 0) {
        if (uniqueDomains && uniqueDomains.some(domain => socialMediaDomains && socialMediaDomains.includes(domain.toLowerCase()))) {
            details += '⚠️ ';
        }
		details += 'Profile Link Domains: ';
		details += uniqueDomains ? uniqueDomains.join(', ') : '';
		details += '\n\n';
	}

	if (mergedNotes.length > 0) {
		details += "User Notes (newest → oldest):\n";
		for (const note of mergedNotes) {
			details += `\t• ${note.displayText}\n`;
		}
	}

	return details;
}

//
// ──────────────────────────────────────────────────────────────
//   Optional Cache Repair Helper
// ──────────────────────────────────────────────────────────────
//
export async function rebuildAuthorCache(context: Devvit.Context, username: string): Promise<void> {
	await clearAllAuthorBreakdownKeys(context, username);
	//console.log(`[Author Breakdown] Rebuilding cache for ${username}...`);
	await getAuthorBreakdown(context, username, true);
}

export async function clearAllAuthorBreakdowns(context: Devvit.Context): Promise<void> {
    const listKey = "authorBreakdownKeys";
    const existing = await context.redis.get(listKey);
    const keys = existing ? JSON.parse(existing) as string[] : [];

    if (keys.length === 0) {
        //console.log("[Cache] No author breakdown caches found.");
        context.ui.showToast("No cached author breakdowns found.");
        return;
    }

    for (const key of keys) {
        await context.redis.del(key);
    }

    await context.redis.del(listKey); // Reset tracker
    //console.log(`[Cache] Cleared ${keys.length} author breakdown caches.`);
    context.ui.showToast(`Cleared ${keys.length} author breakdown caches.`);
}

function getMainDomain(urlString: string) {
    try {
        const hostname = new URL(urlString).hostname; // e.g., www.google.com
        const parts = hostname.split('.');

        // Take the second-to-last part as the "main domain"
        // Works for www.google.com, but may fail on co.uk
        if (parts.length >= 2) {
            return parts[parts.length - 2];
        }

        return hostname; // fallback for single-part hostnames
    } catch {
        return null; // invalid URL
    }
}