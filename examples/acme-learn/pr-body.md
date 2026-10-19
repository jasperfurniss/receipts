## Summary

Learners can now pick up a lesson video where they left off. Behind `resume-playback`.

## Changes

- Save playback progress while a signed-in learner watches
- Resume from saved progress on return, with a "Resuming from" note

## Test Plan

- [ ] Signed-in learner: watch ~40s, leave, return → video resumes at ~40s
- [ ] Flag off → video starts at 0:00
- [ ] Signed out → video starts at 0:00, no progress API calls
- [ ] No console errors on the lesson page
- [ ] Sign in with email and password lands on Courses
- [ ] Copy on the resume note reviewed by design
