# bare-kit's JNI looks up these classes, their fields and the readable()/writable()
# callbacks by name.
-keep class to.holepunch.bare.kit.** { *; }

# libpeartube.so binds its functions to these names.
-keepclasseswithmembernames class com.peartube.app.player.NativePlayer {
    native <methods>;
}
