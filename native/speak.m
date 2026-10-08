//
//  speak.m — local macOS speech engine for the Textbook-to-Voice web app.
//
//  A long-lived helper process. It reads one JSON command per line on stdin and
//  writes one JSON event per line on stdout (NDJSON). Everything runs on-device
//  through the built-in macOS voices; there is no network access at all.
//
//  Commands (stdin):
//    {"cmd":"list"}
//    {"cmd":"speak","id":"…","text":"…","voiceId":"…","rate":0.5}
//    {"cmd":"pause"} | {"cmd":"resume"} | {"cmd":"stop"}
//
//  Events (stdout):
//    {"event":"ready"}
//    {"event":"voices","voices":[{id,name,locale,language},…]}
//    {"event":"start","id":"…"}
//    {"event":"word","id":"…","loc":N,"len":M}
//    {"event":"paused","id":"…"} {"event":"resumed","id":"…"}
//    {"event":"stopped","id":"…"} {"event":"end","id":"…"}
//    {"event":"error","message":"…"}
//
//  `id` echoes the id of the `speak` command the event belongs to. Starting a new
//  utterance implicitly stops the previous one, and the resulting `stopped` event
//  is tagged with the *old* id — so a caller can tell a stale stop from its own.
//
//  `loc`/`len` are UTF-16 offsets into the text that was submitted, which is the
//  same indexing JavaScript uses, so the browser can map them straight onto the
//  DOM.
//

#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#pragma mark - JSON helpers

static void Emit(NSDictionary *payload) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (!data) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void EmitError(NSString *message) {
  Emit(@{@"event" : @"error", @"message" : message ?: @"unknown error"});
}

// Emit an event belonging to a speech session. `sessionId` may be nil for
// events that are not tied to any session.
static void EmitSession(NSString *sessionId, NSDictionary *payload) {
  if (sessionId.length == 0) {
    Emit(payload);
    return;
  }
  NSMutableDictionary *tagged = [payload mutableCopy];
  tagged[@"id"] = sessionId;
  Emit(tagged);
}

#pragma mark - Text chunking

// AVSpeechSynthesizer copes poorly with very long strings, so break the text
// into sentence-sized pieces. Splitting only *after* punctuation keeps the
// prosody natural. Each chunk records where it starts in the original string so
// reported word offsets stay absolute.
static NSArray<NSDictionary *> *ChunkText(NSString *text, NSUInteger maxLen) {
  NSMutableArray<NSDictionary *> *chunks = [NSMutableArray array];
  NSCharacterSet *sentenceEnd =
      [NSCharacterSet characterSetWithCharactersInString:@"。！？!?…；;\n\r"];
  NSUInteger length = text.length;
  NSUInteger start = 0;
  NSUInteger i = 0;

  while (i < length) {
    unichar c = [text characterAtIndex:i];
    BOOL atBreak = [sentenceEnd characterIsMember:c];
    BOOL tooLong = (i - start + 1) >= maxLen;
    if (atBreak || tooLong) {
      // Absorb any run of trailing whitespace into this chunk.
      NSUInteger end = i + 1;
      while (end < length) {
        unichar n = [text characterAtIndex:end];
        if (n == '\n' || n == '\r' || n == ' ' || n == '\t')
          end++;
        else
          break;
      }
      NSString *piece = [text substringWithRange:NSMakeRange(start, end - start)];
      if (piece.length > 0) {
        [chunks addObject:@{@"text" : piece, @"location" : @(start)}];
      }
      start = end;
      i = end;
      continue;
    }
    i++;
  }

  if (start < length) {
    [chunks addObject:@{
      @"text" : [text substringWithRange:NSMakeRange(start, length - start)],
      @"location" : @(start)
    }];
  }
  return chunks;
}

#pragma mark - Speaker

@interface Speaker : NSObject <AVSpeechSynthesizerDelegate, NSSpeechSynthesizerDelegate>
@property(strong) AVSpeechSynthesizer *synth;
@property(strong) NSMutableArray<AVSpeechUtterance *> *queue;
@property(strong) NSMutableArray<NSNumber *> *queueOffsets;
@property(assign) BOOL active;
@property(assign) BOOL paused;
// Identifies the in-flight `speak` command so events can be routed back to the
// caller that asked for them.
@property(copy) NSString *sessionId;
@end

@implementation Speaker

- (instancetype)init {
  if ((self = [super init])) {
    _synth = [[AVSpeechSynthesizer alloc] init];
    _synth.delegate = self;
    _queue = [NSMutableArray array];
    _queueOffsets = [NSMutableArray array];
  }
  return self;
}

#pragma mark Voice catalogue

// NSSpeechSynthesizer is deprecated but remains the only API that enumerates
// *every* installed voice — including the Cantonese voice "Sinji", which
// AVSpeechSynthesisVoice.speechVoices omits.
- (NSArray<NSDictionary *> *)catalogue {
  NSMutableArray<NSDictionary *> *voices = [NSMutableArray array];
  for (NSString *ident in [NSSpeechSynthesizer availableVoices]) {
    NSDictionary *attrs = [NSSpeechSynthesizer attributesForVoice:ident];
    NSString *name = attrs[NSVoiceName];
    NSString *locale = attrs[NSVoiceLocaleIdentifier];
    if (!name || !locale) continue;
    [voices addObject:@{
      @"id" : ident,
      @"name" : name,
      // AVSpeech wants BCP-47 style tags: zh_HK -> zh-HK
      @"locale" : [locale stringByReplacingOccurrencesOfString:@"_" withString:@"-"],
      @"language" : locale,
    }];
  }
  [voices sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    NSComparisonResult byLocale = [a[@"locale"] compare:b[@"locale"]];
    if (byLocale != NSOrderedSame) return byLocale;
    return [a[@"name"] compare:b[@"name"]];
  }];
  return voices;
}

// Voice identifiers differ between the two frameworks (…super-compact… vs
// …compact…), so try progressively looser matches before giving up.
- (AVSpeechSynthesisVoice *)resolveVoice:(NSString *)voiceId locale:(NSString *)locale {
  if (voiceId.length) {
    AVSpeechSynthesisVoice *exact = [AVSpeechSynthesisVoice voiceWithIdentifier:voiceId];
    if (exact) return exact;

    // Identifiers differ only in their module prefix, e.g.
    //   com.apple.voice.compact.zh-HK.Sinji        (NSSpeechSynthesizer)
    //   com.apple.voice.super-compact.zh-HK.Sinji  (AVSpeechSynthesisVoice)
    // so match on the trailing voice name instead.
    NSString *voiceName = [voiceId componentsSeparatedByString:@"."].lastObject;
    if (voiceName.length) {
      for (AVSpeechSynthesisVoice *v in [AVSpeechSynthesisVoice speechVoices]) {
        if ([v.name isEqualToString:voiceName]) return v;
      }
    }
  }
  if (locale.length) {
    AVSpeechSynthesisVoice *byLocale = [AVSpeechSynthesisVoice voiceWithLanguage:locale];
    if (byLocale) return byLocale;
  }
  return [AVSpeechSynthesisVoice voiceWithLanguage:@"zh-CN"];
}

#pragma mark Commands

- (void)speak:(NSDictionary *)command {
  // Implicitly stops whatever is playing; that `stopped` event is tagged with the
  // previous session id, so the caller starting this one can safely ignore it.
  [self haltActiveSession];

  NSString *text = command[@"text"];
  if (![text isKindOfClass:[NSString class]] || text.length == 0) {
    EmitError(@"No text to speak");
    return;
  }

  NSString *voiceId = command[@"voiceId"];
  NSString *locale = command[@"locale"];
  double rate = [command[@"rate"] doubleValue];
  if (rate <= 0) rate = 0.5;
  rate = MAX(0.0, MIN(1.0, rate));

  AVSpeechSynthesisVoice *voice = [self resolveVoice:voiceId locale:locale];
  if (!voice) {
    EmitError(@"No usable system voice found");
    return;
  }

  NSArray<NSDictionary *> *chunks = ChunkText(text, 400);
  if (chunks.count == 0) {
    EmitError(@"Nothing to speak after chunking");
    return;
  }

  self.active = YES;
  self.paused = NO;
  self.sessionId = command[@"id"];
  [self.queue removeAllObjects];
  [self.queueOffsets removeAllObjects];

  for (NSDictionary *chunk in chunks) {
    AVSpeechUtterance *u =
        [AVSpeechUtterance speechUtteranceWithString:chunk[@"text"]];
    u.voice = voice;
    u.rate = (float)rate;
    [self.queue addObject:u];
    [self.queueOffsets addObject:chunk[@"location"]];
  }

  EmitSession(self.sessionId, @{
    @"event" : @"start",
    @"voice" : voice.name ?: @"",
    @"locale" : voice.language ?: @""
  });

  // Queueing every utterance up front keeps the reading continuous.
  for (AVSpeechUtterance *u in self.queue) {
    [self.synth speakUtterance:u];
  }
}

- (void)pause {
  if (!self.active || self.paused) return;
  if ([self.synth pauseSpeakingAtBoundary:AVSpeechBoundaryImmediate]) {
    self.paused = YES;
    EmitSession(self.sessionId, @{@"event" : @"paused"});
  }
}

- (void)resume {
  if (!self.active || !self.paused) return;
  if ([self.synth continueSpeaking]) {
    self.paused = NO;
    EmitSession(self.sessionId, @{@"event" : @"resumed"});
  }
}

// Stop the current utterance without changing which session owns the stop event:
// the event is tagged with the id that was active when the speech was running.
- (void)haltActiveSession {
  BOOL wasActive = self.active || self.synth.isSpeaking;
  NSString *sessionId = self.sessionId;
  self.active = NO;
  self.paused = NO;
  self.sessionId = nil;
  [self.queue removeAllObjects];
  [self.queueOffsets removeAllObjects];
  if (self.synth.isSpeaking || self.synth.isPaused) {
    [self.synth stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  if (wasActive) EmitSession(sessionId, @{@"event" : @"stopped"});
}

- (void)stop {
  [self haltActiveSession];
}

#pragma mark AVSpeechSynthesizerDelegate

- (NSUInteger)baseOffsetForUtterance:(AVSpeechUtterance *)u {
  NSUInteger idx = [self.queue indexOfObjectIdenticalTo:u];
  if (idx == NSNotFound || idx >= self.queueOffsets.count) return 0;
  return [self.queueOffsets[idx] unsignedIntegerValue];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)s
    willSpeakRangeOfSpeechString:(NSRange)r
                       utterance:(AVSpeechUtterance *)u {
  if (!self.active) return;
  NSUInteger base = [self baseOffsetForUtterance:u];
  EmitSession(self.sessionId, @{@"event" : @"word", @"loc" : @(base + r.location), @"len" : @(r.length)});
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)s
    didFinishSpeechUtterance:(AVSpeechUtterance *)u {
  if (!self.active) return;
  // Only the final utterance ends the session.
  if (self.queue.lastObject == u) {
    self.active = NO;
    EmitSession(self.sessionId, @{@"event" : @"end"});
    self.sessionId = nil;
  }
}

// The synthesizer's own pause/continue callbacks are untagged, and the server
// routes events by session id, so they would be dropped anyway. -pause and
// -resume already emit tagged versions.
- (void)speechSynthesizer:(AVSpeechSynthesizer *)s
     didPauseSpeechUtterance:(AVSpeechUtterance *)u {
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)s
    didContinueSpeechUtterance:(AVSpeechUtterance *)u {
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)s
     didCancelSpeechUtterance:(AVSpeechUtterance *)u {
  // Reported through -stop; nothing further to do.
}

@end

#pragma mark - stdin command loop

static NSMutableData *gInputBuffer = nil;
// Held in a global so ARC keeps the source alive after the setup function
// returns; a local dispatch_source_t would be released and never fire.
static dispatch_source_t gStdinSource = nil;

static void HandleLine(NSString *line, Speaker *speaker) {
  line = [line stringByTrimmingCharactersInSet:
                  [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (line.length == 0) return;

  NSError *err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:
                  [line dataUsingEncoding:NSUTF8StringEncoding]
                                             options:0
                                               error:&err];
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    EmitError(@"Malformed command");
    return;
  }

  NSString *cmd = parsed[@"cmd"];
  if ([cmd isEqualToString:@"list"]) {
    Emit(@{@"event" : @"voices", @"voices" : [speaker catalogue]});
  } else if ([cmd isEqualToString:@"speak"]) {
    [speaker speak:parsed];
  } else if ([cmd isEqualToString:@"pause"]) {
    [speaker pause];
  } else if ([cmd isEqualToString:@"resume"]) {
    [speaker resume];
  } else if ([cmd isEqualToString:@"stop"]) {
    [speaker stop];
  } else if ([cmd isEqualToString:@"quit"]) {
    [speaker stop];
    exit(0);
  } else {
    EmitError([NSString stringWithFormat:@"Unknown command: %@", cmd ?: @"(none)"]);
  }
}

static void StartStdinReader(Speaker *speaker) {
  gInputBuffer = [NSMutableData data];
  gStdinSource = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
  dispatch_source_t source = gStdinSource;
  dispatch_source_set_event_handler(source, ^{
    char buf[4096];
    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
    if (n <= 0) {
      // Parent closed the pipe: shut down cleanly.
      exit(0);
    }
    [gInputBuffer appendBytes:buf length:(NSUInteger)n];

    NSData *newline = [@"\n" dataUsingEncoding:NSUTF8StringEncoding];
    while (YES) {
      NSRange nl = [gInputBuffer rangeOfData:newline
                                     options:0
                                       range:NSMakeRange(0, gInputBuffer.length)];
      if (nl.location == NSNotFound) break;
      NSData *lineData = [gInputBuffer subdataWithRange:NSMakeRange(0, nl.location)];
      [gInputBuffer replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
      NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
      HandleLine(line, speaker);
    }
  });
  dispatch_resume(source);
}

int main(void) {
  @autoreleasepool {
    Speaker *speaker = [[Speaker alloc] init];
    StartStdinReader(speaker);
    Emit(@{@"event" : @"ready"});
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
