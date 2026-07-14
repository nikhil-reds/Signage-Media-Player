Sub Main()
    print "Starting REDS Player"

    videoPath = "SD:/media/videos/default-video.mp4"

    ' Use the player's active output mode instead of forcing a mode change.
    videoMode = CreateObject("roVideoMode")
    width = videoMode.GetVideoResX()
    height = videoMode.GetVideoResY()

    ' Safe fallback for a display that has not reported its dimensions yet.
    if width <= 0 then width = 1920
    if height <= 0 then height = 1080

    rectangle = CreateObject("roRectangle", 0, 0, width, height)
    player = CreateObject("roVideoPlayer")

    ' Never call methods on an invalid component; doing so causes an autorun
    ' runtime error and the red error-light flash code.
    if player = invalid then
        print "ERROR: roVideoPlayer could not be created"
        while true
            sleep(10000)
        end while
    end if

    player.SetRectangle(rectangle)
    player.SetViewMode("FillScreenAndCentered")
    player.SetLoopMode(true)

    started = player.PlayFile(videoPath)
    if started = false then
        print "ERROR: Unable to play "; videoPath
    else
        print "Playing "; videoPath
    end if

    ' Keep the autorun process alive while native playback loops.
    while true
        sleep(10000)
    end while
End Sub
