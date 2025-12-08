import { Devvit , TriggerContext, Context } from "@devvit/public-api";
import { ConfirmationResults, getConfirmationResults, setConfirmationResults, deleteConfirmationResults, parseConfirmationResultsWithDates } from "./UserConfirmation.js";
import { AppSettings, getAppSettings } from "./main.js";
import { getAuthorBreakdown } from "./RedditUtils.js"; 

export const verifyForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    const statusDetails = getVerificationDetails(appSettings, confirmationResults.username || '', confirmationResults.verificationStatus || 'unverified', data.banned);
    let description = statusDetails.description.trim();
    let descriptionLineHeight = description.split('\n').length;
    if(descriptionLineHeight > 15) descriptionLineHeight = 15;
    return {
      fields: [
        {
            name: "details",
            label: data.authorBreakdown ? data.authorBreakdown : "u/" + confirmationResults.username,
            type: "paragraph",
            lineHeight: descriptionLineHeight,
            defaultValue: description,
            helpText: "Note: Passing verification does not guarantee they are human",
            disabled: true,
        },
        {
            name: "verifyOverride",
            label: "Mod Override",
            type: "boolean",
            helpText: "Select and click " + statusDetails.buttonLabel + " to choose an override option",
            defaultValue: false,
            required: false,
        }
      ],
      title: statusDetails.detailedStatus,
      acceptLabel: statusDetails.buttonLabel,
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    let username = context.postId ? (await context.reddit.getPostById(context.postId || '')).authorName
                                  : (await context.reddit.getCommentById(context.commentId || '')).authorName;
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    const appSettings = await getAppSettings(context);
    const authorBreakdown = await getAuthorBreakdown(context, username);

    //if mod override selected
    if(values.verifyOverride) {
        context.ui.showForm(modOverrideForm, {appSettings: JSON.stringify(appSettings), confirmationResults: JSON.stringify(confirmationResults), authorBreakdown: authorBreakdown});
        return;
    }
    
    if(appSettings.notifyUserOnVerificationRequest) {
        //if we've reach here, action is to send a verification request
        sendVerificationRequest(context, username, confirmationResults);
        confirmationResults.notified = true;
        confirmationResults.timeNotified = new Date();
    }
    else {
        //this should never happen, notify on requests should always be done
        console.log("No notification of request sent. (This should never happen)");
        context.ui.showToast({text: 'u/' + username + ' was not notified of request'});
    }
    confirmationResults.verificationStatus = 'pending';
    await setConfirmationResults(context, username, confirmationResults);
    context.ui.showToast({text: 'u/' + username + ' notified to confirm human', appearance: 'success'});
  }
);

export const modOverrideForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    const statusDetails = getVerificationDetails(appSettings, confirmationResults.username || '', confirmationResults.verificationStatus || 'unverified');
    let authorBreakdown = data.authorBreakdown;
    if(authorBreakdown.includes('u/') && authorBreakdown.includes('| ')) {
      authorBreakdown = authorBreakdown.substring(authorBreakdown.indexOf("|") + 1).trim();
    }
    return {
      fields: [
        {
          name: "authorBreakdown",
          type: "string",
          label: "u/" + confirmationResults.username + " Breakdown",
          disabled: true,
          defaultValue: authorBreakdown ? authorBreakdown : "",
        },
        {
            name: "verifyOverride",
            label: "Verification Override",
            type: "select",
            options: getOverrideOptions(appSettings, confirmationResults.verificationStatus || 'unverified'),
            helpText: "⚠️ Select manually set verification status (no notification sent to user) and click Override",
            defaultValue: [],
            required: false,
        },
        //TODO notify
        // {
        //     name: "notifyOfOverride",
        //     label: "Notify User",
        //     type: "boolean",
        //     helpText: "Send u/" + confirmationResults.username + " a notification",
        //     defaultValue: [true],
        //     required: false,
        // },
      ],
      title: statusDetails.detailedStatus + " - Mod Override",
      acceptLabel: 'Override',
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    const username = values.status.substring(values.status.indexOf('u/') + 2, values.status.indexOf(" "));
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;

    //if mod override selected
    if(values.verifyOverride) {
        if(values.verifyOverride[0] === 'mark_unverified') {
            await deleteConfirmationResults(context, username || '');
            //TODO notify
            context.ui.showToast({text: 'u/' + username + ' Overriden To Unverified', appearance: 'success'});
            return;
        }
        if(values.verifyOverride[0] === 'mark_verified') {
            confirmationResults.verificationStatus = 'verified';
            confirmationResults.modOverridenStatus = true;
            await setConfirmationResults(context, username, confirmationResults);
            //TODO notify
            context.ui.showToast({text: 'u/' + username + ' Overriden To Verified', appearance: 'success'});
            return;
        }
        if(values.verifyOverride[0] === 'mark_failed') {
            confirmationResults.verificationStatus = 'failed';
            confirmationResults.modOverridenStatus = true;
            await setConfirmationResults(context, username, confirmationResults);
            //TODO notify
            context.ui.showToast({text: 'u/' + username + ' Overriden To Failed', appearance: 'success'});
            return;
        }
    }
  }
);

async function sendVerificationRequest(
	context: Context | TriggerContext,
	username: string,
	confirmationResults: ConfirmationResults
): Promise<void> {
	console.log(`Sending verification request to u/${username}`);

	const subredditName = context.subredditName || '';
	const status = confirmationResults.verificationStatus || 'unverified';
	let notificationModmailId = confirmationResults.notificationModmailId;

	// Shared instructions for all messages
	const instructions =
		`To complete verification:\n\n` +
		`1. Go to r/${subredditName}\n` +
		`2. Select "Confirm Human" from the three-dot (...) menu\n` +
		`3. Answer the questions and click "Confirm"\n\n` +
		`Your content may be temporarily removed until verification is complete.\n\n` +
		`If you need help finding or using the form, you can reply to this message.`;

	let modmailSubject: string | undefined;
	let modmailMessage: string | undefined;

	// ---- Build subject & message per status ----
	switch (status) {
		case 'unverified':
			modmailSubject = `Verification requested`;
			modmailMessage =
				`Hi,\n\n` +
				`You’re not in trouble, but your account was flagged by r/${subredditName} for review.\n\n` +
				`To continue posting and commenting, please complete a quick verification.\n\n` +
				instructions +
				`\n\nPlease note: verification requests may expire if not completed in time.`;
			break;

		case 'pending':
			modmailSubject = `Reminder: Complete verification`;
			modmailMessage =
				`This is a reminder to complete your verification in r/${subredditName}.\n\n` +
				instructions +
				`\n\nIf your request expires, reply here and a moderator can help.`;
			break;

		case 'timeout':
			modmailSubject = `Verification timed out — new request`;
			modmailMessage =
				`Your previous verification request expired, but a new one has been sent.\n\n` +
				instructions +
				`\n\nIf this happens again, reply here and a moderator can help.`;
			break;

		case 'failed':
			modmailSubject = `Verification failed — try again`;
			modmailMessage =
				`Your previous verification attempt was not successful, but you may try again.\n\n` +
				instructions +
				`\n\nIf you believe this was a mistake, you can reply here.`;
			break;

		case 'verified':
			modmailSubject = `New verification request`;
			modmailMessage =
				`You’ve previously completed verification, but a new request has been sent.\n\n` +
				instructions +
				`\n\nIf you have questions, you can reply here.`;
			break;

		default:
			// fallback to unverified style
			modmailSubject = `Verification requested`;
			modmailMessage =
				`Hi,\n\n` +
				`Your account in r/${subredditName} requires verification.\n\n` +
				instructions;
	}

	let conversationId = '';

	// ---- Reuse existing modmail if possible ----
	if (notificationModmailId && modmailMessage) {
		await context.reddit.modMail.reply({
			body: modmailMessage,
			conversationId: notificationModmailId,
		});
		conversationId = notificationModmailId;
	} else {
		const modmail = await context.reddit.modMail.createConversation({
			subredditName,
			subject: modmailSubject || '',
			body: modmailMessage || '',
			to: username,
		});
		conversationId = modmail.conversation.id || '';
		confirmationResults.notificationModmailId = conversationId;
		await setConfirmationResults(context, confirmationResults.username, confirmationResults);
	}

	// ---- Archive conversation after sending ----
	await context.reddit.modMail.archiveConversation(conversationId);
}

Devvit.addMenuItem({
  label: "Check Human Status",
  description: "Request human verification or check status",
  location: "post",
  forUserType: "moderator",
  onPress: async (event, context) => {
    console.log(`Menu item 'Verify Human' pressed:\n${JSON.stringify(event)}`);
    const post = await context.reddit.getPostById(event.targetId || '');
    if(!post) {
      console.log('Post not found for verification.');
      return;
    }
    console.log('user json? ' + JSON.stringify((await context.reddit.getUserById(post.authorId || ''))?.toJSON()));
    const username = (await context.reddit.getUserById(post.authorId || ''))?.username || '';
    if(!username) {
      console.log('Post author username not found for verification.');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {  
      confirmationResults = {
        username: username,
      };
      await setConfirmationResults(context, username, confirmationResults);
    }
    const authorBreakdown = await getAuthorBreakdown(context, username);
    context.ui.showForm(verifyForm, {appSettings: JSON.stringify(await getAppSettings(context)), confirmationResults: JSON.stringify(confirmationResults), authorBreakdown: authorBreakdown, banned: await isBanned(context, username)});
  },
});

Devvit.addMenuItem({
  label: "Check Human Status",
  description: "Request human verification or check status",
  location: "comment",
  forUserType: "moderator",
  onPress: async (event, context) => {
    console.log(`Menu item 'Verify Human' pressed:\n${JSON.stringify(event)}`);
    const comment = await context.reddit.getCommentById(event.targetId || '');
    if(!comment) {
      console.log('Comment not found for verification.');
      return;
    }
    const username = (await context.reddit.getUserById(comment.authorId || ''))?.username || '';
    if(!username) {
      console.log('Comment author username not found for verification.');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {  
      confirmationResults = {
        username: username,
      };
      await setConfirmationResults(context, username, confirmationResults);
    }
    const authorBreakdown = await getAuthorBreakdown(context, username);
    context.ui.showForm(verifyForm, {appSettings: JSON.stringify(await getAppSettings(context)), confirmationResults: JSON.stringify(confirmationResults), authorBreakdown: authorBreakdown, banned: await isBanned(context, username)});
  },
});

function getVerificationDetails(
  appSettings: AppSettings,
  username: string,
  status: string,
  banned = false
): { detailedStatus: string; description: string; buttonLabel: string } {

  const verified = status === 'verified';
  const pending = status === 'pending';
  const timeout = status === 'timeout';
  const failed = status === 'failed';
  const unverified = !status || status === 'unverified';

  // AppSettings enforcement
  const removePending = appSettings.actionOnPendingVerification === 'remove';
  const reportPending = appSettings.actionOnPendingVerification === 'report';
  const removeTimeout = appSettings.actionOnTimeoutVerification === 'remove';
  const reportTimeout = appSettings.actionOnTimeoutVerification === 'report';
  const banOnFail = appSettings.banOnFailedVerification;

  let detailedStatus = '';
  let buttonLabel = '';
  const parts: string[] = [];

  // ---- Banner ----
  if (verified) detailedStatus = `🟢 u/${username} Verified`;
  else if (pending) detailedStatus = `🟡 u/${username} Verification Pending`;
  else if (timeout) detailedStatus = `🟠 u/${username} Verification Timed Out`;
  else if (failed) detailedStatus = `🔴 u/${username} Verification Failed`;
  else detailedStatus = `⚪️ u/${username} Not Verified`;

  // ---- CTA ----
  if (verified) buttonLabel = 'Request Verification Again';
  else if (pending) buttonLabel = 'Send Reminder';
  else if (timeout || failed) buttonLabel = 'Request Verification Again';
  else buttonLabel = 'Request Verification';

  // ---- Status Intro ----
  if (verified) parts.push('User has successfully completed verification.');
  else if (pending) parts.push('A verification request has been sent.');
  else if (timeout) parts.push('The user did not complete verification in time.');
  else if (failed) parts.push('The user failed verification.');
  else parts.push('This user has not been verified.');

  // ---- Current Enforcement (emoji flags) ----
  const currentEnforcement: string[] = [];
  const isRemovingNow = !banned && ((pending && removePending) || (timeout && removeTimeout) || (failed && (removePending || removeTimeout)));
  const isReportingNow = !banned && ((pending && reportPending) || (timeout && reportTimeout) || (failed && (reportPending || reportTimeout)));

  if (banned) currentEnforcement.push('⛔️ User is banned from posting');
  else {
    if (isRemovingNow) currentEnforcement.push('⛔️ Content is currently being removed');
    if (isReportingNow) currentEnforcement.push('⚠️ Content is currently being reported');
  }

  if (currentEnforcement.length) {
    parts.push('');
    parts.push('Current Enforcement:');
    parts.push(...currentEnforcement);
  }

  // ---- CTA line ----
  parts.push('');
  parts.push(`Press "${buttonLabel}" to ${buttonLabel.includes('Reminder') ? 'send a reminder' : 'send a new request'}.`);

  // ---- Consequences ----
  if (!pending) {
    const removeBullets: string[] = [];
    const reportBullets: string[] = [];
    const banBullets: string[] = [];

    // Remove content bullets
    if (!banned && (removePending || removeTimeout)) {
      removeBullets.push('Until verification is complete');
      if (timeout && removeTimeout) removeBullets.push('If verification times out');
      if (failed && (removePending || removeTimeout)) removeBullets.push('If verification fails');
    }

    // Report content bullets
    if (!banned && (reportPending || reportTimeout)) {
      reportBullets.push('Until verification is complete');
      if (timeout && reportTimeout) reportBullets.push('If verification times out');
      if (failed && (reportPending || reportTimeout)) reportBullets.push('If verification fails');
    }

    // Ban bullets
    if (banOnFail) {
      if (banned) banBullets.push('User will stay banned');
      else if (failed) banBullets.push('If verification fails: User will be banned');
    }

    if (removeBullets.length || reportBullets.length || banBullets.length) {
      parts.push('');
      parts.push('If you proceed:');
      parts.push(''); // extra spacing for readability

      if (removeBullets.length) {
        const heading = isRemovingNow ? 'Content Will Continue Being Auto-Removed:' : 'Content Will Be Auto-Removed:';
        parts.push(heading);
        removeBullets.forEach(b => parts.push(`• ${b}`));
      }

      if (reportBullets.length) {
        const heading = isReportingNow ? 'Content Will Continue Being Auto-Reported:' : 'Content Will Be Auto-Reported:';
        parts.push(heading);
        reportBullets.forEach(b => parts.push(`• ${b}`));
      }

      if (banBullets.length) {
        parts.push('User Will Be Banned:');
        banBullets.forEach(b => parts.push(`• ${b}`));
      }
    }
  }

  const description = parts.join('\n');

  return {
    detailedStatus,
    description,
    buttonLabel,
  };
}

function getOverrideOptions(
	appSettings: AppSettings,
	status: string
): { label: string; value: string }[] {

	const options: { label: string; value: string }[] = [];

	const pending = status === 'pending';
	const timeout = status === 'timeout';
	const failed  = status === 'failed';

	const removePending  = appSettings.actionOnPendingVerification === 'remove';
	const reportPending  = appSettings.actionOnPendingVerification === 'report';
	const removeTimeout  = appSettings.actionOnTimeoutVerification === 'remove';
	const reportTimeout  = appSettings.actionOnTimeoutVerification === 'report';

	// ---- Determine active content enforcement ----
	let contentActionNote = '';

	if ((pending && removePending) || (timeout && removeTimeout) || failed) {
		contentActionNote = ' (Stops Removing Content)';
	} else if ((pending && reportPending) || (timeout && reportTimeout)) {
		contentActionNote = ' (Stops Reporting Content)';
	}

	// ---- Failed behavior note ----
	const failActionNote = appSettings.banOnFailedVerification
		? ' (Bans User)'
		: ' (Starts Removing New Content)';

	// ---- Tense helper for failed state ----
	const again = (timeout || failed) ? ' Again' : '';

	// ---- Options ----
	if (status !== 'verified') {
		options.push({
			label: `🟢 Mark as Verified${contentActionNote}`,
			value: 'mark_verified'
		});
	}

	if (status !== 'unverified') {
		options.push({
			label: `⚪️ Mark as Unverified${contentActionNote}`,
			value: 'mark_unverified'
		});
	}

	if (status !== 'failed') {
		options.push({
			label: `🔴 Mark as Failed${again}${failActionNote}`,
			value: 'mark_failed'
		});
	}

	return options;
}

async function isBanned(context: Context | TriggerContext, username?: string, subredditName?: string): Promise<boolean> {
    const user = username ?? context.username;
    const subreddit = subredditName ?? context.subredditName;

    if (!user || !subreddit) return false;

    const bannedUsers = await context.reddit
        .getBannedUsers({ subredditName: subreddit, username: user })
        .get(1);

    return bannedUsers.some(u => u.username === user);
}