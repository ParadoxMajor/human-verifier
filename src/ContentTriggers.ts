import { Devvit , TriggerContext, Context, UserNoteLabel } from "@devvit/public-api";
import { ConfirmationResults, getConfirmationResults, setConfirmationResults } from "./UserConfirmation.js";
import { AppSettings, getAppSettings } from "./main.js";
import { sendVerificationRequest } from "./ModControl.js";
import { checkForModPerms, getModPerms } from "./RedditUtils.js";

// Handling a PostSubmit event
Devvit.addTrigger({
  event: 'PostCreate',
  onEvent: async (event, context) => {
    const username = event.author?.name;
    if(!username) {
      console.log('No username found in PostSubmit event.');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {
      return;
    }

    const appSettings = await getAppSettings(context);
    await handlePostOrComment(true, event.post?.id || '', context, username, confirmationResults, appSettings);
  }
});

//Handling a CommentSubmit event
Devvit.addTrigger({
  event: 'CommentCreate',
  onEvent: async (event, context) => {
    const username = event.author?.name;
    if(!username) {
      console.log('No username found in CommentSubmit event.');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {
      return;
    }

    const appSettings = await getAppSettings(context);
    await handlePostOrComment(false, event.comment?.id || '', context, username, confirmationResults, appSettings);
  }
});

async function handlePostOrComment(isPost: boolean, contentId: string, context: TriggerContext, username: string, confirmationResults: ConfirmationResults, appSettings: AppSettings): Promise<void> {
  const subredditName = context.subredditName || '';
  let action = '';
  let reason = '';
  let modmailRemovalSubject = '';
  let modmailRemovalMessage = '';

  const verified = confirmationResults.verificationStatus === 'verified';
  const unverified = !confirmationResults.verificationStatus || confirmationResults.verificationStatus === 'unverified';
  if(verified || unverified) {
    return;
  }
  console.log(`\n${isPost ? 'Post' : 'Comment'} submitted by u/${username} (Verification Status: ${confirmationResults.verificationStatus})`);
  const pending = confirmationResults.verificationStatus === 'pending';
  let timeout = confirmationResults.verificationStatus === 'timeout';
  const failed = confirmationResults.verificationStatus === 'failed';

  // AppSettings enforcement
  const banOnTimeout = appSettings.banOnConfirmationTimeout;

  const contentString = isPost ? 'Post' : 'Comment';
  const commentId = isPost ? '' : contentId.split("_")[1];
  const postId = isPost ? contentId.split("_")[1] : (await context.reddit.getCommentById(contentId)).postId.split('_')[1];

  //check if timed out since notified
  const pendingTimeoutMinutes = appSettings.pendingConfirmationTimeoutMinutes;
  if (
    !timeout &&
    pendingTimeoutMinutes > 0 &&
    confirmationResults.timeNotified
  ) {
    const elapsedMs = Date.now() - confirmationResults.timeNotified.getTime();
    const timeoutMs = pendingTimeoutMinutes * 60 * 1000;

    if (elapsedMs > timeoutMs) {
      confirmationResults.verificationStatus = 'timeout';
      timeout = true;
      await setConfirmationResults(context, username, confirmationResults);

      // ---- Add mod note (if needed) ---- 
      if(appSettings.trackVerificationInModNotes && !banOnTimeout) {
        const { subredditName, postId, commentId } = context; 
        const baseOptions: any = {subreddit: subredditName, 
                                  user: confirmationResults.username, 
                                  note: 'u/' + username + ' timed out to confirm human verification', 
                                  modnoteLabel: 'SPAM_WARNING' as UserNoteLabel }; 
        const redditId = postId ?? commentId; 
        if (redditId) { 
          baseOptions.redditId = redditId; 
        } 
        try { 
          await context.reddit.addModNote(baseOptions);
        }
        catch (error) {
          console.error('Failed to add mod note on verification timeout', error);
        }
      }
    }
  }

  const contentURL = isPost
      ? `https://www.reddit.com/r/${subredditName}/comments/${postId}`
      : `https://www.reddit.com/r/${subredditName}/comments/${postId}/comment/${commentId}?context=3`;
  const kindLink = `[${contentString.toLowerCase()}](${contentURL})`

  if(failed) {
      console.log(`User u/${username} has failed verification. Taking appropriate action on ${contentString.toLocaleLowerCase()} submission.`); 
      action = appSettings.spamFailedVerification ? 'spam' : 'remove';
      reason = 'Human verification failed';
      modmailRemovalSubject = 'Notification: ' + contentString + ' Removed Due to Failed Human Verification';
      modmailRemovalMessage = `Your recent ${kindLink} in r/${subredditName} has been removed because you failed the required human verification process. Please contact the moderation team if you believe this is a mistake.`;
  }
  else if(timeout) {
      console.log(`User u/${username} has timed out verification. Taking appropriate action on ${contentString.toLocaleLowerCase()} submission.`); 
      action = appSettings.actionOnTimeoutVerification;
      reason = 'Human verification timed out' + (action === 'report' ? ', please review' : '');
      modmailRemovalSubject = 'Notification: ' + contentString + ' Removed Due to Timed Out Human Verification';
      modmailRemovalMessage = `Your recent ${kindLink} in r/${subredditName} has been removed because you did not complete the required human verification process in time. Please contact the moderation team if you believe this is a mistake.`;
  }
  else if(pending) {
      console.log(`User u/${username} has pending verification. Taking appropriate action on post submission.`); 
      action = appSettings.actionOnPendingVerification;
      reason = 'Human verification pending' + (action === 'report' ? ', please review' : '');
      modmailRemovalSubject = 'Notification: ' + contentString + ' Removed Due to Pending Human Verification';
      modmailRemovalMessage = `Your recent ${kindLink} in r/${subredditName} has been removed because your human verification process is still pending. Please complete the verification to avoid further actions on your posts.`; 
  }

  if(action === 'remove' || action === 'spam' || action === 'report') {
    const content = isPost ? await context.reddit.getPostById(contentId || '') : await context.reddit.getCommentById(contentId || '');
    if(!content) {
      console.log(isPost ? 'No post data in PostSubmit event.' : 'No comment data in CommentSubmit event.');
      return;
    }
    if(action === 'remove' || action === 'spam') {
      await context.reddit.remove(contentId, action === 'spam');

      //get or create a custom removal reason for logging
      try {
        const reasonId = await getOrCreateCustomReasonId(context.reddit, subredditName);
        await content.addRemovalNote({
          reasonId: reasonId,
          modNote: reason,
        });
      }
      catch(error) {
        console.log('Failed to add mod note', error);
      }

      if(appSettings.notifyUserPostAndCommentRemovals) {
        let conversationId = '';
        const notificationModmailId = confirmationResults.notificationModmailId;
        if(notificationModmailId) {
          await context.reddit.modMail.reply({
            body: modmailRemovalMessage,
            conversationId: notificationModmailId,
          });
          conversationId = notificationModmailId;
        }
        else {
          const modmail = await context.reddit.modMail.createConversation({
              subredditName: context.subredditName || '',
              subject: modmailRemovalSubject,
              body: modmailRemovalMessage,
              to: username,
          });
          conversationId = modmail.conversation.id || '';
          confirmationResults.notificationModmailId = conversationId;
          await setConfirmationResults(context, confirmationResults.username, confirmationResults);
        }
        await context.reddit.modMail.archiveConversation(conversationId);
      }
    }
    else if(action === 'report') { 
      console.log(`Reporting u/${username}'s ${contentString.toLocaleLowerCase()} for human verification status: ${confirmationResults.verificationStatus}.`); 
      await context.reddit.report(content, {reason: reason});
    }

    if(timeout && banOnTimeout) {
      console.log(`User u/${username} has timed out verification. Banning user on post submission.`);
      await context.reddit.banUser({
        username: content.authorName || '',
        subredditName: subredditName || '',
        reason: 'Failure to complete human verification in time, banned automatically',
        context: contentId,
        message: 'You have been banned for failing to complete the human verification process in time. If you believe this is a mistake, please reply to this modmail.',
      });
    }
  }
}

async function getOrCreateCustomReasonId(
  reddit: Devvit.Context['reddit'],
  subredditName: string
): Promise<string> {
  const reasons = await reddit.getSubredditRemovalReasons(subredditName);

  const existing = reasons.find((r) => r.title === 'Custom Reason');
  if (existing) return existing.id;

  const newId = await reddit.addSubredditRemovalReason(subredditName, {
    title: 'Custom Reason',
    message: '<Enter reason here>',
  });

  return newId;
}

// Handling a ModMail event
Devvit.addTrigger({
  event: 'ModMail',
  onEvent: async (event, context) => {
    const response = await context.reddit.modMail.getConversation({
      conversationId: event.conversationId,
    });
    const conversation = response.conversation;

    if (!conversation) {
      console.warn('ModMail conversation not found:', event.conversationId);
      return;
    }
    
    const targetUsername = conversation.participant?.name;
    if (!targetUsername) {
      //not a conversation with a user
      return;
    }

    const messages = Object.values(conversation.messages);
    const latestMessage = Object.values(conversation.messages)
          .filter(m => m.date)
          .sort(
            (a, b) => new Date(b.date!).getTime() - new Date(a.date!).getTime()
          )[0];

    if(!latestMessage || !latestMessage.author?.isMod) {
      return;
    }
    const text = latestMessage.bodyMarkdown?.trim().toLowerCase() ?? '';
    if(text.startsWith('!checkhuman')) {
      console.log('\nFound a !checkHuman command in modmail: ' + text);

      const parts = text.split(/\s+/);
      const command = parts[0];        // !checkhuman
      let subcommand = parts.length > 1 ? parts[1].toLowerCase().trim() : undefined;     // request | undefined

      const confirmationResults = await getConfirmationResults(context, targetUsername) as ConfirmationResults;

      let resultMessage = '';
      if(!subcommand || subcommand.toLowerCase().trim() !== 'request') {
        resultMessage = '\n\nCommand not recognized:\n\n' + '>' + text + '\n\n';
        resultMessage += '`!checkHuman request` - Sends user a new verification request. (posts and access perms required)';
      }
      else if(confirmationResults) {
        if(!await checkForModPerms(context, ['posts', 'access'], latestMessage?.author?.name)) {
          resultMessage = 'u/' + latestMessage?.author?.name + ' does not have permissions for the !checkHuman request command';
        }
        else {
          if(subcommand.toLowerCase().trim() === 'request') {
            if(confirmationResults.verificationStatus !== 'pending') {
              if((await getAppSettings(context)).notifyUserOnVerificationRequest) {
                await sendVerificationRequest(context, targetUsername, confirmationResults);
                //resultMessage = "Sent u/" + targetUsername + ' new verification request';
                confirmationResults.verificationStatus = 'pending';
                if(confirmationResults.modOverridenStatus) confirmationResults.modOverridenStatus = false;
                await setConfirmationResults(context, targetUsername, confirmationResults);
                return;
              }
              else {
                console.log('Notifications to users are disabled in app settings (this should never happen). Not sending verification request to u/' + targetUsername);
                resultMessage = "Verification request sent, but notifications to users are disabled in app settings.";
              }
            }
            else {
               resultMessage = "u/" + targetUsername + ' is already pending verification';
            }
          }
          //TODO other commands?
        }
      }
      else {
        resultMessage = 'Command failed: No original request yet. Request from a post or comment.';
      }

      await context.reddit.modMail.reply({
        body: resultMessage,
        conversationId: event.conversationId,
        isInternal: true,
      });
    }
  }
});