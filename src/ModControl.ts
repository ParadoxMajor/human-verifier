import { Devvit , TriggerContext, Context } from "@devvit/public-api";
import { ConfirmationResults, getConfirmationResults, setConfirmationResults, deleteConfirmationResults, parseConfirmationResultsWithDates } from "./UserConfirmation.js";
import { getAppSettings } from "./main.js";

export const verifyForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    const statusDetails = getVerificationStatus(confirmationResults.username || '', confirmationResults.verificationStatus || 'unverified');
    return {
      fields: [
        {
            name: "status",
            label: "Verification Status",
            type: "string",
            defaultValue: statusDetails.status,
            helpText: statusDetails.action,
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
      title: "Check Human Status",
      acceptLabel: statusDetails.buttonLabel,
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    const username = values.status.substring(values.status.indexOf('u/') + 2, values.status.indexOf(" "));
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;

    //if mod override selected
    if(values.verifyOverride) {
        context.ui.showForm(modOverrideForm, {confirmationResults: JSON.stringify(confirmationResults)});
        return;
    }
    
    if((await getAppSettings(context)).notifyUserOnVerificationRequest) {
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
    const statusDetails = getVerificationStatus(confirmationResults.username || '', confirmationResults.verificationStatus || 'unverified');
    return {
      fields: [
        {
            name: "status",
            label: "Verification Status",
            type: "string",
            defaultValue: statusDetails.status,
            helpText: statusDetails.action,
            disabled: true,
        },
        {
            name: "verifyOverride",
            label: "Verification Override",
            type: "select",
            options: getOverrideOptions(confirmationResults.verificationStatus || 'unverified'),
            helpText: "⚠️ Select manually set verification status (no notification sent to user) and click Override",
            defaultValue: [],
            required: false,
        }
      ],
      title: "Human Status - Mod Override",
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
            context.ui.showToast({text: 'u/' + username + ' Overriden To Unverified', appearance: 'success'});
            return;
        }
        if(values.verifyOverride[0] === 'mark_verified') {
            confirmationResults.verificationStatus = 'verified';
            confirmationResults.modOverridenStatus = true;
            await setConfirmationResults(context, username, confirmationResults);
            context.ui.showToast({text: 'u/' + username + ' Overriden To Verified', appearance: 'success'});
            return;
        }
        if(values.verifyOverride[0] === 'mark_failed') {
            confirmationResults.verificationStatus = 'failed';
            confirmationResults.modOverridenStatus = true;
            await setConfirmationResults(context, username, confirmationResults);
            context.ui.showToast({text: 'u/' + username + ' Overriden To Failed', appearance: 'success'});
            return;
        }
    }
  }
);

async function sendVerificationRequest(context: Context | TriggerContext, username: string, confirmationResults: ConfirmationResults): Promise<void> {
    console.log(`Sending verification request to u/${username}`);
    
    const subredditName = context.subredditName || '';
    const unverified = !confirmationResults.verificationStatus || confirmationResults.verificationStatus === 'unverified' || '';
    const pending = confirmationResults.verificationStatus === 'pending';
    const timeout = confirmationResults.verificationStatus === 'timeout';
    const failed = confirmationResults.verificationStatus === 'failed';
    const verified = confirmationResults.verificationStatus === 'verified';
    let notificationModmailId = confirmationResults.notificationModmailId;
    let modmailSubject = undefined;
    let modmailMessage = undefined;

    if(unverified) {
        modmailSubject = `r/${subredditName} requested human verification`;
        modmailMessage = `Hi, you're not in trouble, but your account was flagged in r/${subredditName} as possibly being a bot.\n\n` +
        `This means your posts and comments will be auto-removed until you confirm you are human.\n\n` +
        `You can do that by going to r/${subredditName} and selecting "Confirm Human" from the "..." overflow menu. ` +
        `Answer the questions in the form and click "Confirm". If you are a bot, be honest.\n\n` + 
        //TODO add link to wiki page with better steps and screenshots?
        `Sorry for the inconvience if you are human, and we appreciate taking the time to confirm. Please reply if you need any further assistence finding or using the form.\n\n` +
        `*Please note your verification may timeout if you take too long.*`;
    }
    else if (pending) {
        modmailSubject = `You have a pending verification request in r/${subredditName}`;
        modmailMessage = `This is a reminder to confirm you are human in r/${subredditName}. ` +
        `Your posts and comments will be auto-removed until you complete this process. \n\n` +
        `You can do this by going to r/${subredditName} and selecting "Confirm Human" from the "..." overflow menu. ` +
        `Answer the questions in the form and click "Confirm". If you are a bot, be honest.\n\n` +
        //TODO add link to wiki page with better steps and screenshots?
        `*Please note your verification may timeout if you take too long. If that happens, reply to mods here for help.*`;
    }
    else if (timeout) {
        modmailSubject = `You have timed out your verification in r/${subredditName}, but can try again`;
        modmailMessage = `You took too long to confirm you are human in r/${subredditName}, but you've been sent a new request. ` +
        `Your posts and comments will be auto-removed until you complete this process. \n\n` +
        `You can do this by going to r/${subredditName} and selecting "Confirm Human" from the "..." overflow menu. ` +
        `Answer the questions in the form and click "Confirm". If you are a bot, be honest.\n\n` +
        //TODO add link to wiki page with better steps and screenshots?
        `*Please note your verification may timeout again if you take too long. If that happens, reply to mods here for help.*`;
    }
    else if (failed) {
        modmailSubject = `You have failed your verification in r/${subredditName}, but can try again`;
        modmailMessage = `You failed to confirm you are human in r/${subredditName}, but you've been sent a new request. ` +
        `Your posts and comments will be auto-removed until you complete this process. \n\n` +
        `You can do this by going to r/${subredditName} and selecting "Confirm Human" from the "..." overflow menu. ` +
        `Answer the questions in the form and click "Confirm". If you are a bot, be honest.\n\n` +
        //TODO add link to wiki page with better steps and screenshots?
        `*Please note your verification may timeout if you take too long. If that happens, reply to mods here for help.*`;
    }
    else if (verified) {
        modmailSubject = `r/${subredditName} requested new human verification`;
        modmailMessage = `You have previously confirmed you are human in r/${subredditName}, but you've been sent a new request. ` +
        `Your posts and comments will be auto-removed until you complete this process. \n\n` +
        `You can do this by going to r/${subredditName} and selecting "Confirm Human" from the "..." overflow menu. ` +
        `Answer the questions in the form and click "Confirm". If you are a bot, be honest.\n\n` +
        //TODO add link to wiki page with better steps and screenshots?
        `*Please note your verification may timeout if you take too long. If that happens, reply to mods here for help.*`;
    }

    let conversationId = '';
    if(notificationModmailId && modmailMessage) {
        await context.reddit.modMail.reply({
            body: modmailMessage,
            conversationId: notificationModmailId,
        });
        conversationId = notificationModmailId;
    }
    else {
        const modmail = await context.reddit.modMail.createConversation({
            subredditName: subredditName,
            subject: modmailSubject || '',
            body: modmailMessage || '',
            to: username,
        });
        conversationId = modmail.conversation.id || '';
        confirmationResults.notificationModmailId = conversationId;
        await setConfirmationResults(context, confirmationResults.username, confirmationResults);
    }
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
    context.ui.showForm(verifyForm, {confirmationResults: JSON.stringify(confirmationResults)});
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
    context.ui.showForm(verifyForm, {confirmationResults: JSON.stringify(confirmationResults)});
  },
});

function getVerificationStatus(username: string, status: string): {status: string, action: string, buttonLabel: string} {
  if(status === 'verified') {
    return {
      status: `u/${username} Verified 🟢`,
      action: "Click 'Verify Again' to request they try to confirm again, blocking them from posting and commenting until they do.",
      buttonLabel: 'Verify Again',
    }
  }
  else if(status === 'pending') {
    return {
      status: `u/${username} Verification Pending 🟡`,
      action: "User has been sent a verification request. They must complete verification to be able to post and comment.",
      buttonLabel: 'Send Reminder',
    }
  }
  else if(status === 'timeout') {
    return {
      status: `u/${username} Verification Timed Out 🟠`,
      action: "User did not complete verification in time. They are blocked from posting and commenting. Click 'Verify Again' to request they try to confirm again.",
      buttonLabel: 'Verify Again',
    }
  }
  else if(status === 'failed') {
    return {
      status: `u/${username} Verification Failed 🔴`,
      action: "User failed the verification challenge. They are blocked from posting and commenting. Click 'Verify Again' to request they try to confirm again",
      buttonLabel: 'Verify Again',
    }
  }
  else {
    return {
      status: `u/${username} Unverified ⚪️`,
      action: "User is not verified. Click 'Verify' to send them a request, blocking them from posting and commenting until they complete verification.",
      buttonLabel: 'Verify',  
    }
  }
}

function getOverrideOptions(status: string): {label: string, value: string}[] {
  let options = [];
  if(status !== 'verified') {
    options.push({label: '🟢 Mark as Verified' + (status !== 'unverified' ? ' (Unblocks Posting/Commenting)' : ''), value: 'mark_verified'});
  }
  if(status !== 'unverified') {
    options.push({label: '⚪️ Mark as Unverified', value: 'mark_unverified'});
  }
  if(status !== 'failed') {
    options.push({label: '🔴 Mark as Failed (Blocks Posting/Commenting)', value: 'mark_failed'});
  }
  return options;
}