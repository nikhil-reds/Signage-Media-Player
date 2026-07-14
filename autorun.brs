Sub Main()
    print "Starting SignLink Player Autorun Script"
    
    ' Set up video mode (Landscape Full HD)
    vm = CreateObject("roVideoMode")
    vm.SetMode("1920x1080x60p")
    
    ' Create a message port for receiving events
    mp = CreateObject("roMessagePort")
    
    ' HTML Widget configuration
    ' Assuming player files are placed on the root of the SD card
    config = {
        url: "file:///SD:/index.html",
        javascript_enabled: true,
        security_rules: {
            file_access: "all",
            cross_origin_access: "all"
        },
        enable_web_inspector: true
    }
    
    ' Create the HTML Widget to fit the screen
    htmlRect = CreateObject("roRectangle", 0, 0, 1920, 1080)
    htmlWidget = CreateObject("roHtmlWidget", htmlRect, config)
    htmlWidget.SetPort(mp)
    htmlWidget.Show()
    
    ' Event loop to keep the player running and capture events
    while true
        msg = wait(0, mp)
        if type(msg) = "roHtmlWidgetEvent" then
            eventData = msg.GetData()
            print "HTML Event: "; eventData
        endif
    end while
End Sub
