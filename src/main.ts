import { Devvit, type FormField, TriggerContext, Context } from "@devvit/public-api";
import { ConfirmationResults } from "./UserConfirmation.js";
import './ModControl';
import './UserConfirmation';
import './ContentTriggers';

Devvit.configure({
  redditAPI: true,
});

export interface AppSettings {
	trackVerificationInModNotes: boolean;
	banOnFailedVerification: boolean;
	spamFailedVerification: boolean;
	notifyUserOnVerificationRequest: boolean;
	actionOnPendingVerification: 'remove' | 'report' | 'nothing';
	actionOnTimeoutVerification: 'remove' | 'report' | 'nothing';
	notifyUserPostAndCommentRemovals: boolean;
	pendingConfirmationTimeoutMinutes: number;
	banOnConfirmationTimeout: boolean;
	minHumanTimeToOpenConfirmForm: number;
	minHumanTimeToConfirmHuman: number;
	allowConfirmingWithoutNotification: boolean;
	chatGPTUsageAllowed: 'all' | 'some' | 'translations' | 'nothing';

	// Repeat offender thresholds
	repeatOffenderRemovalThreshold: number;
	repeatOffenderBanThreshold: number;
	repeatOffenderMuteThreshold: number;

	//Flagged profile social media links
	socialMedialFlaggedDomains: string;
}

/**
 * Fetch all app settings in one go
 */
export async function getAppSettings(context: Context | TriggerContext): Promise<AppSettings> {
	const trackVerificationInModNotes = await context.settings.get('trackVerificationInModNotes') as boolean;
	const banOnFailedVerification = await context.settings.get('banOnFailedVerification') as boolean;
	const spamFailedVerification = await context.settings.get('spamFailedVerification') as boolean;
	const notifyUserOnVerificationRequest = await context.settings.get('notifyUserOnVerificationRequest') as boolean;
	const actionOnPendingVerification = ((await context.settings.get('actionOnPendingVerification')) as string[])[0] as 'remove' | 'report' | 'nothing';
	const actionOnTimeoutVerification = ((await context.settings.get('actionOnTimeoutVerification')) as string[])[0] as 'remove' | 'report' | 'nothing';
	const notifyUserPostAndCommentRemovals = await context.settings.get('notifyUserPostAndCommentRemovals') as boolean;
	const pendingConfirmationTimeoutMinutes = parseInt((await context.settings.get('pendingConfirmationTimeoutMinutes')) as string ?? '60', 10);
	const banOnConfirmationTimeout = await context.settings.get('banOnConfirmationTimeout') as boolean;
	const minHumanTimeToOpenConfirmForm = parseInt((await context.settings.get('minHumanTimeToOpenConfirmForm')) as string ?? '5', 10);
	const minHumanTimeToConfirmHuman = parseInt((await context.settings.get('minHumanTimeToConfirmHuman')) as string ?? '15', 10);
	const allowConfirmingWithoutNotification = await context.settings.get('allowConfirmingWithoutNotification') as boolean;
	const chatGPTUsageAllowed = ((await context.settings.get('chatGPTUsageAllowed')) as string[])[0] as 'all' | 'some' | 'translations' | 'nothing';

	const repeatOffenderRemovalThreshold = parseInt((await context.settings.get('repeatOffenderRemovalThreshold')) as string ?? '3', 10);
	const repeatOffenderBanThreshold = parseInt((await context.settings.get('repeatOffenderBanThreshold')) as string ?? '1', 10);
	const repeatOffenderMuteThreshold = parseInt((await context.settings.get('repeatOffenderMuteThreshold')) as string ?? '2', 10);

	const socialMedialFlaggedDomains = (await context.settings.get('socialMedialFlaggedDomains')) as string ?? '';

	return {
		trackVerificationInModNotes,
		banOnFailedVerification,
		spamFailedVerification,
		notifyUserOnVerificationRequest,
		actionOnPendingVerification,
		actionOnTimeoutVerification,
		notifyUserPostAndCommentRemovals,
		pendingConfirmationTimeoutMinutes,
		banOnConfirmationTimeout,
		minHumanTimeToOpenConfirmForm,
		minHumanTimeToConfirmHuman,
		allowConfirmingWithoutNotification,
		chatGPTUsageAllowed,
		repeatOffenderRemovalThreshold,
		repeatOffenderBanThreshold,
		repeatOffenderMuteThreshold,
    	socialMedialFlaggedDomains,
	};
}

Devvit.addSettings(
[
	{
		name: "allowConfirmingWithoutNotification",
		type: "boolean",
		label: "Allow Confirming Without Notification",
		defaultValue: true,
		helpText: "Allow users to confirm they are human even if they were not requested to by mods (and not automatically requested once feature is available)",
	},
	{
		
		type: 'group',
		label: 'Tracking & Notifications',
		fields: [
			{
				name: "trackVerificationInModNotes",
				type: "boolean",
				label: "Track Verification In Mod Notes",
				defaultValue: true,
				helpText: "Keep a record of user verification attempts and statuses in moderator notes",
			},
			{
				name: "notifyUserOnVerificationRequest",
				type: "boolean",
				label: "Notify User On Verification Request",
				defaultValue: true,
				disabled: true,
				helpText: "Notify users when they are sent a verification request. (This setting is informative only as users should always be notified they were requested to confirm)",
			},
			{
				name: "notifyUserPostAndCommentRemovals",
				type: "boolean",
				label: "Notify User On Post/Comment Removals",
				defaultValue: true,
				helpText: "Notify users when their posts or comments are removed due to confirmation pending, timeout, or failure",
			},
		],
	},
	{
		type: 'group',
		label: 'Verification Failure Behavior',
		fields: [
			{
				name: "banOnFailedVerification",
				type: "boolean",
				label: "Ban On Failed Verification",
				defaultValue: false,
				helpText: "Automatically ban users who fail the human verification",
			},
			{
				name: "spamFailedVerification",
				type: "boolean",
				label: "Spam Posts/Comments On Failed Verification",
				defaultValue: true,
				helpText: "If users aren't banned on failed verification, remove their posts and comments as spam instead of regular removal",
			},
		]
	},
	{
		type: 'group',
		label: 'Pending & Timeout Behavior',
		fields: [
			{
				name: "pendingConfirmationTimeoutMinutes",
				type: "number",
				label: "Pending Timeout (in minutes)",
				defaultValue: 1440,
				helpText: "How long to give users to confirm they're human once they were notified (0 means no timeout, 1440 is 24 hours)",
			},
			{
				name: "actionOnPendingVerification",
				type: "select",
				label: "Action During Pending Verification",
				options: [
					{ label: "Remove", value: "remove" },
					{ label: "Report", value: "report" },
					{ label: "Do Nothing", value: "nothing" },
				],
				defaultValue: ['remove'],
				helpText: "Select what to do to posts/comments made while user verification is pending",
			},
			{
				name: "banOnConfirmationTimeout",
				type: "boolean",
				label: "Ban On Confirmation Timeout",
				defaultValue: false,
				helpText: "Automatically ban users who don't confirm in time",
			},
			{
				name: "actionOnTimeoutVerification",
				type: "select",
				label: "Action During Timeout Verification",
				options: [
					{ label: "Remove", value: "remove" },
					{ label: "Report", value: "report" },
					{ label: "Do Nothing", value: "nothing" },
				],
				defaultValue: ['remove'],
				helpText: "If not banned on timeout, select what to do to posts/comments made when user verification times out",
			},
		]
	},
	{
		type: 'group',
		label: 'Verification Failure Criteria',
		fields: [
			{
				name: "minHumanTimeToOpenConfirmForm",
				type: "number",
				label: "Min Time to Open Confirmation Form (in seconds)",
				defaultValue: 3,
				helpText: "Any quicker is considered too fast for humans to get the notification, go to the subreddit, and open the confirmation form",
			},
			{
				name: "minHumanTimeToConfirmHuman",
				type: "number",
				label: "Min Time to Complete Confirmation Form (in seconds)",
				defaultValue: 10,
				helpText: "Any quicker is considered too fast for humans to read and complete the form to confirm they are human",
			},
			{
				name: "chatGPTUsageAllowed",
				type: "select",
				label: "Chat GPT / AI Human Usage Allowed",
				options: [
					{ label: "All ChatGPT-AI Usage Allowed", value: "all" },
					{ label: "Some ChatGPT/AI Usage Allowed", value: "some" },
					{ label: "ChatGPT/AI Usage in Language Translation Only", value: "translations" },
					{ label: "No ChatGPT-AI Usage Allowed", value: "nothing" },
				],
				defaultValue: ['all'],
				helpText: "Let human users indicate ChatGPT/AI usage without failing",
			},
		]
	},
	{
		type: 'group',
		label: 'Author Breakdown Options',
		fields: [
			{
				name: "repeatOffenderRemovalThreshold",
				type: "number",
				label: "Removals / Spam Threshold for Repeat Offender",
				defaultValue: 3,
				helpText: "Number of removal/spam actions before a user is marked as a repeat offender (⚠️) in User Breakdown."
			},
			{
				name: "repeatOffenderBanThreshold",
				type: "number",
				label: "Bans Threshold for Repeat Offender",
				defaultValue: 1,
				helpText: "Number of bans before a user is marked as a repeat offender (⚠️) in User Breakdown."
			},
			{
				name: "repeatOffenderMuteThreshold",
				type: "number",
				label: "Mutes Threshold for Repeat Offender",
				defaultValue: 2,
				helpText: "Number of mutes before a user is marked as a repeat offender (⚠️) in User Breakdown."
			},
			{
				name: "socialMedialFlaggedDomains",
				type: "string",
				label: "Social Media Profile Link Domains to Flag",
				defaultValue: '',
				helpText: "Comma separated (like 'onlyfans,facebook'). Any domains in a profile's text or social media links to flag (⚠️) in User Breakdown."
			},
		]
	}
]);

export default Devvit;
