import { Devvit , TriggerContext, Context, UserNoteLabel, FormField } from "@devvit/public-api";
import { ConfirmationResults, getConfirmationResults, setConfirmationResults, deleteConfirmationResults, parseConfirmationResultsWithDates, getResultUsernames, clearAllResults } from "./UserConfirmation.js";
import { AppSettings, getAppSettings } from "./main.js";
import { checkForModPerms, getAuthorBreakdown, getModPerms, getRedditPlatformGroup } from "./RedditUtils.js"; 
import { formatDistanceToNow } from "date-fns";

export const verifyForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    const statusDetails = getVerificationDetails(appSettings, confirmationResults.username || '', confirmationResults.verificationStatus || 'unverified', data.banned);
    let description = statusDetails.description.trim();
    description += confirmationResults.failureReportPlain
      ? '\n\n---------------------------\n\n' + confirmationResults.failureReportPlain + '\n\n'
      : '';
    let descriptionLineHeight = description.split('\n').length;
    if(descriptionLineHeight > 15) descriptionLineHeight = 15;
    return {
      fields: [
        {
          name: "authorBreakdown",
          type: "string",
          label: "Breakdown",
          disabled: true,
          defaultValue: data.authorBreakdown ? data.authorBreakdown : "",
        },
        {
            name: "details",
            label: "u/" + confirmationResults.username,
            type: "paragraph",
            lineHeight: descriptionLineHeight,
            defaultValue: description,
            helpText: "Note: Passing verification does not guarantee they are human",
            disabled: true,
        },
      ],
      title: statusDetails.detailedStatus,
      acceptLabel: statusDetails.buttonLabel,
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    if(!await checkForModPerms(context, ['posts', 'access'])) {
      console.log('u/' + context.username + ' has unsufficent mod perms');
      context.ui.showToast('❌ You need posts and access perms');
      return;
    }
    
    let username = context.postId ? (await context.reddit.getPostById(context.postId || '')).authorName
                                  : (await context.reddit.getCommentById(context.commentId || '')).authorName;
    if(!username) {
      username = values.authorBreakdown.match(/u\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    const appSettings = await getAppSettings(context);
    
    if(appSettings.notifyUserOnVerificationRequest) {
        //if we've reach here, action is to send a verification request
        try {
          sendVerificationRequest(context, username, confirmationResults);
        }
        catch(error) {
          console.error('Failed to send verification request:', error);
          context.ui.showToast('❌ Failed to send verification request');
          return;
        }
        confirmationResults.notified = true;
        confirmationResults.timeNotified = new Date();
    }
    else {
        //this should never happen, notify on requests should always be done
        console.log("No notification of request sent. (This should never happen)");
        context.ui.showToast({text: 'u/' + username + ' was not notified of request'});
    }
    confirmationResults.verificationStatus = 'pending';
    if(confirmationResults.modOverridenStatus) confirmationResults.modOverridenStatus = false;
    await setConfirmationResults(context, username, confirmationResults);
    context.ui.showToast({text: 'u/' + username + ' notified to confirm human', appearance: 'success'});
  }
);

export async function sendVerificationRequest(
	context: Context | TriggerContext,
	username: string,
	confirmationResults: ConfirmationResults
): Promise<void> {
  if(!username) {
	  console.log(`Unable to send verification request to u/${username}`);
    try {
      (context as Context).ui.showToast('User is deleted, suspended, or shadowbanned, so unable to send request');
    }
    catch(error) {}
    return;
  }

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
				`Hi u/${username},\n\n` +
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

	// ---- Add mod note (if needed) ----
  if((await getAppSettings(context)).trackVerificationInModNotes) {
    const { subredditName, postId, commentId } = context;
    const baseOptions: any = {
      subreddit: subredditName,
      user: username,
      label: 'SPAM_WARNING',
      note: 'Human verification request sent by u/' + context.username,
    };
    const redditId = postId ?? commentId;
    if (redditId) {
      baseOptions.redditId = redditId;
    }
    await context.reddit.addModNote(baseOptions);
  }
}

Devvit.addMenuItem({
  label: "Check Human Status",
  description: "Request human verification or check status",
  location: "post",
  forUserType: "moderator",
  onPress: async (event, context) => {
    console.log(`\nMenu item 'Check Human Status' pressed by u/${context.username}:\n${JSON.stringify(event)}`);

    const post = await context.reddit.getPostById(event.targetId || '');
    if(!post) {
      console.log('Post not found for verification.');
      context.ui.showToast('❌ Check Failed: Post not found');
      return;
    }
    const username = (await context.reddit.getUserById(post.authorId || ''))?.username || '';
    if(!username) {
      console.log('Post author username not found for verification.');
      context.ui.showToast('❌ Check Failed: Username not found');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {  
      confirmationResults = {
        username: username,
      };
      await setConfirmationResults(context, username, confirmationResults);
    }
    let authorBreakdown = await getAuthorBreakdown(context, username);
    //remove username from breakdown, since it's already shown
    authorBreakdown = authorBreakdown.replace(/^[^|]+\s\|\s/, '');
    context.ui.showForm(verifyForm, {appSettings: JSON.stringify(await getAppSettings(context)), confirmationResults: JSON.stringify(confirmationResults), authorBreakdown: authorBreakdown, banned: await isBanned(context, username)});
  },
});

Devvit.addMenuItem({
  label: "Check Human Status",
  description: "Request human verification or check status",
  location: "comment",
  forUserType: "moderator",
  onPress: async (event, context) => {
    console.log(`\nMenu item 'Check Human Status' pressed by u/${context.username}:\n${JSON.stringify(event)}`);
    const comment = await context.reddit.getCommentById(event.targetId || '');
    if(!comment) {
      console.log('Comment not found for verification.');
      context.ui.showToast('❌ Check Failed: Post not found');
      return;
    }
    const username = (await context.reddit.getUserById(comment.authorId || ''))?.username || '';
    if(!username) {
      console.log('Comment author username not found for verification.');
      context.ui.showToast('❌ Check Failed: Username not found');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {  
      confirmationResults = {
        username: username,
      };
      await setConfirmationResults(context, username, confirmationResults);
    }
    let authorBreakdown = await getAuthorBreakdown(context, username);
    //remove username from breakdown, since it's already shown
    authorBreakdown = authorBreakdown.replace(/^[^|]+\s\|\s/, '');
    context.ui.showForm(verifyForm, {appSettings: JSON.stringify(await getAppSettings(context)), confirmationResults: JSON.stringify(confirmationResults), authorBreakdown: authorBreakdown, banned: await isBanned(context, username)});
  },
});

Devvit.addMenuItem({
  label: "Check Verification Statuses",
  description: "Check all statuses and override results",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (event, context) => {
    console.log(`\nMenu item 'Check Verification Statuses' pressed by u${context.username}:\n${JSON.stringify(event)}`);
    await prepareCheckVerificationStatusesForm(context);
  },
});

async function prepareCheckVerificationStatusesForm(context:Context, usernameFilter?: string) {
  console.log('Preparing `Check Verification Statuses` form' + (usernameFilter ? ' (Filter: \'' + usernameFilter + '\')' : ''));

  let usernames = await getResultUsernames(context);
  let fullUsernameCount = usernames.length as number;
  if(usernameFilter) {
    usernames = usernames.filter(element => element.toLowerCase().includes(usernameFilter.toLowerCase()));
  }
  const fullPreFilteredCount = fullUsernameCount;
  fullUsernameCount = usernames.length as number;

  if(fullPreFilteredCount === 0) {
    console.log('No results yet, so showing toast instead');
    context.ui.showToast('No Results Yet');
    return;
  }

  if(fullUsernameCount > 100) {
    usernames = usernames.slice(-100);
  }
  usernames = usernames.reverse();

  let verificationBreakdown = fullUsernameCount === fullPreFilteredCount && fullUsernameCount === usernames.length ? 
                            fullUsernameCount + ' Results' : 
                            (fullUsernameCount === fullPreFilteredCount && fullUsernameCount > usernames.length ?
                              usernames.length + ' Results (100 Most Recent)' :
                              (fullUsernameCount < fullPreFilteredCount && fullUsernameCount === usernames.length ? 
                                fullUsernameCount + ' Filtered Results' : fullUsernameCount + ' Filtered Results (100 Most Recent)')
                            );

  let usernameOptions = new Array<{label:string, value:string}>;
  for(const username of usernames) {
    let usernameLabel = '';
    const confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    const verificationStatus = confirmationResults.verificationStatus;
    let timelapse = '';
    if(verificationStatus === 'verified') {
      usernameLabel = '✅ u/' + username + ' (' + verificationStatus + ')';
    }
    else if(verificationStatus === 'failed') {
      usernameLabel = '❌ u/' + username + ' (' + verificationStatus + ')';
    }
    else if(verificationStatus === 'timeout') {
      usernameLabel = '💤 u/' + username + ' (' + verificationStatus + ')';
    }
    else if(verificationStatus === 'pending') {
      timelapse = confirmationResults.notified && confirmationResults.timeNotified ? 
                      ' - ' + formatDistanceToNow(new Date(confirmationResults.timeNotified)) : '';
      usernameLabel = '💬 u/' + username + ' (' + verificationStatus + timelapse + ')';
    }
    else if(verificationStatus === 'unverified') {
      usernameLabel = '⚪️ u/' + username + ' (' + verificationStatus + ')';
    }
    usernameOptions.push({label: usernameLabel, value: username});
  }

  const showDeleteAllToggle = await canDeleteAllCache(context, await getAppSettings(context));
  let canViewModmail = await checkForModPerms(context, ['mail']);
  //TODO if Reddit allows loading modmails via links on the app, remove this check:
  if(canViewModmail && getRedditPlatformGroup(context) === 'app') {
    canViewModmail = false;
  }
  const canOverride = await checkForModPerms(context, ['posts', 'access']);

  console.log('Showing Check Verification Statuses form...');
  context.ui.showForm(verifyAllForm, {fullUsernameCount, verificationBreakdown, usernameOptions: JSON.stringify(usernameOptions), usernameFilter: usernameFilter ? usernameFilter : '', showDeleteAllToggle, canViewModmail, canOverride});
}

export const verifyAllForm = Devvit.createForm(
  (data) => {
    const usernameOptions = JSON.parse(data.usernameOptions);
    //const countLabel = data.fullUsernameCount === usernameOptions.length ? 'Select from ' + data.fullUsernameCount + ' statuses': 
                      //'Select from the ' + usernameOptions.length + ' most recent statuses or type a username';
    let actionOptions = [{label: 'View Details', value: 'viewDetails'}];
    if(data.canViewModmail) actionOptions.push({label: 'View Modmail Notification', value: 'viewModmail'});
    if(data.canOverride) actionOptions.push({label: 'Override Status', value: 'override'});
    let fields = [] as FormField[];
    fields.push(
      {
          name: "verificationBreakdown",
          label: "Verification Breakdown",
          type: "string",
          defaultValue: data.verificationBreakdown,
          disabled: true,
      }
    );
    fields.push(
      {
          label: "Username",
          type: "group",
          fields: [
            {
                name: "usernameFilter",
                label: "Filter Username",
                type: "string",
                helpText: 'To filter \'Select Username\', enter text and press \'Go\'',
                defaultValue: data.usernameFilter ? data.usernameFilter : '',
                disabled: false,
            },
            {
                name: "usernameSelect",
                label: "Select Username",
                type: "select",
                options: usernameOptions,
                helpText: 'Select username for action',
                defaultValue: [],
                disabled: false,
            }
          ]
      }
    );
    fields.push(
      {
          name: "actionSelect",
          label: "Select Action",
          type: "select",
          options: actionOptions,
          helpText: 'Select an action and press \'Go\'',
          defaultValue: ['viewDetails'],
          disabled: false,
          required: true,
      }
    );
    if(data.showDeleteAllToggle) {
      fields.push(
        {
            name: "deleteAllResultData",
            label: "Delete All Result Data",
            type: "boolean",
            helpText: "Select and press 'Override'. ⚠️ This cannot be undone ⚠️",
            defaultValue: false,
        }
      );
    }
    return {
      fields: fields,
      title: 'Check Verification Statuses',
      acceptLabel: 'Go',
      cancelLabel: 'Close',
    }
  },
  async ({ values }, context) => {
    const username =  values.usernameSelect?.length > 0 ? values.usernameSelect[0] : undefined;
    const usernameFilter = values.usernameFilter?.trim();
    const action = values.actionSelect[0] as 'viewDetails' | 'viewModmail' | 'override';

    if(action === 'override' && username && !await checkForModPerms(context, ['posts', 'access'])) {
      console.log('u/' + context.username + ' has unsufficent mod perms to override user status');
      context.ui.showToast('❌ You need posts and access perms to override user status');
      return;
    }
    if(values.deleteAllResultData && !await checkForModPerms(context, ['all'])) {
      console.log('u/' + context.username + ' has unsufficent mod perms to delete all data');
      context.ui.showToast('❌ You need all perms to delete all data');
      return;
    }

    //if delete all override selected
    if(values.deleteAllResultData) {
      console.log('\'Check Verification Statuses\' u/'+ context.username + ' preparing to delete all cache');
      const usernames = await getResultUsernames(context);
      context.ui.showForm(clearCacheForm, {resultCount: usernames.length});
      return;
    }

    console.log('\'Check Verification Statuses\' u/'+ context.username + ' preparing to ' + action + ' for user ' + username);

    let confirmationResults = undefined;
    if(username) {
      confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    }
    if(!confirmationResults) {
      console.log('No result found, so filtering on entered text \'' + (usernameFilter ? usernameFilter : '') + '\'');
      //if not result found, try filtering
      await prepareCheckVerificationStatusesForm(context, usernameFilter);
      return;
    }
    if(action === 'viewDetails') {
      console.log('Starting next step of ' + action + ' for ' + username);
      let authorBreakdown = await getAuthorBreakdown(context, username);
      //remove username from breakdown, since it's already shown
      authorBreakdown = authorBreakdown.replace(/^[^|]+\s\|\s/, '');
      context.ui.showForm(verifyForm, {appSettings: JSON.stringify(await getAppSettings(context)), 
                                      confirmationResults: JSON.stringify(confirmationResults), 
                                      authorBreakdown: authorBreakdown, 
                                      banned: await isBanned(context, username)});
    }

    else if(action === 'viewModmail') {
      console.log('Starting next step of ' + action + ' for ' + username);
      if(confirmationResults?.notificationModmailId) {
        const modmailURL = 'https://mod.reddit.com/mail/all/' + confirmationResults.notificationModmailId;
        console.log('Is this the correct modmail URL? - ' + modmailURL);
        context.ui.navigateTo(modmailURL);
      }
      else {
        console.log('u/' + username + ' doesn\'t have a notification modmail to view');
        context.ui.showToast('u/' + username + ' doesn\'t have a notification modmail to view');
      }
    }

    else if(action === 'override') {
      console.log('Starting next step of ' + action + ' for ' + username);
      //otherwise overriding a selected or typed username
      if(!confirmationResults) {  
        confirmationResults = {
          username: username,
        };
        await setConfirmationResults(context, username, confirmationResults);
      }
      let authorBreakdown = await getAuthorBreakdown(context, username);
      context.ui.showForm(modOverrideForm, {appSettings: JSON.stringify(await getAppSettings(context)), 
                                            confirmationResults: JSON.stringify(confirmationResults), 
                                            authorBreakdown: authorBreakdown, 
                                            banned: await isBanned(context, username)});
    }
  }
);

export const modOverrideForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    const statusDetails = getVerificationDetails(appSettings, confirmationResults.username || '', confirmationResults.verificationStatus || 'unverified');
    let authorBreakdown = data.authorBreakdown;
    return {
      fields: [
        {
          name: "authorBreakdown",
          type: "string",
          label: "u/" +  confirmationResults.username+ " Breakdown",
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
    if(!await checkForModPerms(context, ['posts', 'access'])) {
      console.log('u/' + context.username + ' has unsufficent mod perms');
      context.ui.showToast('❌ You need posts and access perms');
      return;
    }

    const username = values.authorBreakdown.match(/u\/([A-Za-z0-9_-]+)/)?.[1] ?? null;

    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    const appSettings = await getAppSettings(context);
    let modNoteLabel = undefined;
    let modNote = undefined

    //if mod override selected
    if(values.verifyOverride) {
        if(values.verifyOverride[0] === 'mark_unverified') {
            confirmationResults.verificationStatus = 'unverified';
            confirmationResults.modOverridenStatus = true;
            confirmationResults.notified = false;
            confirmationResults.timeNotified = undefined;
            confirmationResults.timeStarted = undefined;
            confirmationResults.timeLapseSeconds = undefined;
            confirmationResults.timeToOpenInSeconds = undefined;
            confirmationResults.timeCompleted = undefined;
            await setConfirmationResults(context, username, confirmationResults);
            //TODO notify with notifyOfOverride?
            const outcome = 'Overriden To Unverified';
            context.ui.showToast({text: outcome, appearance: 'success'});
            modNote = outcome + ' by u/' + context.username;
        }
        //TODO delete entire results override?
        else if(values.verifyOverride[0] === 'mark_verified') {
            confirmationResults.verificationStatus = 'verified';
            confirmationResults.modOverridenStatus = true;
            await setConfirmationResults(context, username, confirmationResults);
            //TODO notify with notifyOfOverride?
            const outcome = 'Overriden To Verified';
            context.ui.showToast({text: outcome, appearance: 'success'});
            modNote = outcome + ' by u/' + context.username;
        }
        else if(values.verifyOverride[0] === 'mark_failed') {
            if((await getModPerms(context, username)).length > 0) {
              context.ui.showToast({text: 'u/' + username + ' is a mod, so skipping failure override'});
              return;
            }
            confirmationResults.verificationStatus = 'failed';
            confirmationResults.modOverridenStatus = true;
            await setConfirmationResults(context, username, confirmationResults);
            let banned = false;
            if(appSettings.banOnFailedVerification) {
                console.log(`User u/${confirmationResults.username} has been mod-overriden to fail verification. Banning user`);
                await context.reddit.banUser({
                    username: confirmationResults.username,
                    subredditName: context.subredditName || '',
                    reason: 'Mod-Overriden to Fail Human Verification by u/' + context.username,
                    message: 'You have been banned for failing the human verification process. If you believe this is a mistake, please reply to this modmail.',
                });
                banned = true; 
            }
            //TODO notify with notifyOfOverride?
            const outcome = 'Overriden To Failed' + (banned ? ' (User Banned)' : '');
            context.ui.showToast({text: outcome, appearance: 'success'});
            modNoteLabel = (banned ? 'BOT_BAN' : 'SPAM_WATCH') as UserNoteLabel
            modNote = outcome + ' by u/' + context.username;
        }

        // ---- Add mod note (if needed) ----
        if(appSettings.trackVerificationInModNotes && modNote) {
          const { subredditName, postId, commentId } = context;
          const baseOptions: any = {
            subreddit: subredditName,
            user: username,
            note: modNote,
          };
          const redditId = postId ?? commentId;
          if (redditId) {
            baseOptions.redditId = redditId;
          }
          if(modNoteLabel) {
            baseOptions.modNoteLabel = modNoteLabel;
          }
          await context.reddit.addModNote(baseOptions);
        }
    }
  }
);

export const clearCacheForm = Devvit.createForm(
  (data) => {
    return {
      fields: [
        {
          name: 'confirmation',
          type: 'boolean',
          label: '⚠️ Are you sure you want to clear all cache for ' + data.resultCount + ' result' + (data.resultCount !== 1 ? 's' : '') + '?',
          helpText: 'This can\'t be undone',
          defaultValue: false,
        },
      ],
      title: 'Clear All Result Data?',
      acceptLabel: '⚠️ Clear All ' + data.resultCount + ' Result' + (data.resultCount !== 1 ? 's' : '') + ' From Cache',
      cancelLabel: 'Cancel',
    }
  },
  async ({ values }, context) => {
    const canDelete = await canDeleteAllCache(context, await getAppSettings(context));
    if(canDelete && values.confirmation) {
      await clearAllResults(context);
      const usernames = await getResultUsernames(context);
      if(usernames.length === 0) {
        context.ui.showToast({text: '✅ Cleared All Result Data', appearance: 'success'});
      }
      else {
        context.ui.showToast({text: '❎ Failed to Clear Result Data'});
      }
    }
    else if(!canDelete) {
      context.ui.showToast('You need access to clear all result data');
    }
    else {
      context.ui.showToast({text: 'Confirmation not selected, so no data cleared'});
    }
  }
);

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
  const banOnTimeout = appSettings.banOnConfirmationTimeout;

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
  const isRemovingNow = !banned && ((pending && removePending) || (timeout && removeTimeout) || failed);
  const isReportingNow = !isRemovingNow && !banned && ((pending && reportPending) || (timeout && reportTimeout));

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
  const removeBullets: string[] = [];
  const reportBullets: string[] = [];
  const banBullets: string[] = [];

  parts.push('');
  parts.push((pending ? 'If/when user completes' : 'If you proceed') + ' and verification fails:');

  if(banOnFail) {
    parts.push('• ' + (!banned ? ' User will be banned' : '⛔️ User will remain banned'));
  }
  else {
    if(banned) { 
      parts.push('• ⛔️ User will remain banned until unbanned manually. If done:');
    }
    if(removeTimeout) {
      parts.push((banned ? '\t' : '') + '• ' + (isRemovingNow ? 'Content will continue being auto-removed' : 'Content will be auto-removed'));
    }
  }

  parts.push('');

  parts.push('Or if verification times out:');

  if(banOnTimeout) {
    parts.push('• ' + (!banned ? ' User will be banned' : '⛔️ User will remain banned'));
  }
  else {
    if(banned) { 
      parts.push('• ⛔️ User will remain banned until unbanned manually. If done:');
    }
    if(removeTimeout) {
      parts.push((banned ? '\t' : '') + '• ' + (isRemovingNow ? 'Content will continue being auto-removed' : 'Content will be auto-removed'));
    }
    else if(reportTimeout) {
      parts.push((banned ? '\t' : '') + '• ' + (isReportingNow ? 'Content will continue being auto-reported' : 'Content will Be auto-reported'));
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

async function canDeleteAllCache(context:Context, appSettings: AppSettings): Promise<boolean> {
  const deleteAllCacheOverrideScope = appSettings.deleteAllCacheOverrideScope;
  if(!deleteAllCacheOverrideScope || deleteAllCacheOverrideScope === 'none') {
    return false;
  }

  if(deleteAllCacheOverrideScope === 'full-mod') {
    return checkForModPerms(context, ['all']);
  }
  return false;
}

export async function isBanned(context: Context | TriggerContext, username?: string, subredditName?: string): Promise<boolean> {
    const user = username ?? context.username;
    const subreddit = subredditName ?? context.subredditName;

    if (!user || !subreddit) return false;

    const bannedUsers = await context.reddit
        .getBannedUsers({ subredditName: subreddit, username: user })
        .get(1);

    return bannedUsers.some(u => u.username === user);
}