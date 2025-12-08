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
	failVerificationIfChatGPTUsed: boolean;

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
	const failVerificationIfChatGPTUsed = await context.settings.get('failVerificationIfChatGPTUsed') as boolean;

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
		failVerificationIfChatGPTUsed,
		repeatOffenderRemovalThreshold,
		repeatOffenderBanThreshold,
		repeatOffenderMuteThreshold,
    	socialMedialFlaggedDomains,
	};
}

Devvit.addSettings(
[
	{
		name: "trackVerificationInModNotes",
		type: "boolean",
		label: "Track Verification In Mod Notes",
		defaultValue: true,
		helpText: "Keep a record of user verification attempts and statuses in moderator notes",
	},
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
	{
		name: "notifyUserOnVerificationRequest",
		type: "boolean",
		label: "Notify User On Verification Request",
		defaultValue: true,
    disabled: true,
		helpText: "Notify users when they are sent a verification request. (This setting is informative only as users should always be notified they were requested to confirm)",
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
		name: "actionOnTimeoutVerification",
		type: "select",
		label: "Action During Timeout Verification",
    options: [
      { label: "Remove", value: "remove" },
      { label: "Report", value: "report" },
      { label: "Do Nothing", value: "nothing" },
    ],
		defaultValue: ['remove'],
		helpText: "Select what to do to posts/comments made when user verification times out",
	},
	{
		name: "notifyUserPostAndCommentRemovals",
		type: "boolean",
		label: "Notify User On Post/Comment Removals",
		defaultValue: true,
		helpText: "Notify users when their posts or comments are removed due to confirmation pending, timeout, or failure",
	},
	{
		name: "pendingConfirmationTimeoutMinutes",
		type: "number",
		label: "Pending Timeout (in minutes)",
		defaultValue: 60,
		helpText: "How lonb to give users to confirm they're human once they were notified (0 means no timeout)",
	},
	{
		name: "banOnConfirmationTimeout",
		type: "boolean",
		label: "Ban On Confirmation Timeout",
		defaultValue: false,
		helpText: "Automatically ban users who don't confirm in time (see 'Pending Timeout (in minutes)' setting)",
	},
	{
		name: "minHumanTimeToOpenConfirmForm",
		type: "number",
		label: "Min Time to Open Confirmation Form (in seconds)",
		defaultValue: 5,
		helpText: "Any quicker is considered too fast for humans to get the notification, go to the subreddit, and open the confirmation form",
	},
	{
		name: "minHumanTimeToConfirmHuman",
		type: "number",
		label: "Min Time to Complete Confirmation Form (in seconds)",
		defaultValue: 15,
		helpText: "Any quicker is considered too fast for humans to read and complete the form to confirm they are human",
	},
	{
		name: "allowConfirmingWithoutNotification",
		type: "boolean",
		label: "Allow Confirming Without Notification",
		defaultValue: true,
		helpText: "Allow users to confirm they are human even if they were not requested to by mods (and not automatically requested once feature is available)",
	},
	{
		name: "failVerificationIfChatGPTUsed",
		type: "boolean",
		label: "Fail Verification For ChatGPT/AI Usage",
		defaultValue: false,
		helpText: "Automatically fail human confirmation if user indicates they use ChatGPT or other AI tools to help compose posts/comments",
	},
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
]);

export default Devvit;
