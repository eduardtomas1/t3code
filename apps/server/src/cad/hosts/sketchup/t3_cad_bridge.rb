# T3 Code CAD Bridge loader. T3 Code installs this file and the t3_cad_bridge
# folder into SketchUp's Plugins folder; remove both to uninstall.
require 'sketchup.rb'
require 'extensions.rb'

module T3Code
  module CadBridge
    unless file_loaded?(__FILE__)
      # SketchUp 2017-2019 ship a Ruby that lacks APIs the bridge relies on.
      if Sketchup.version.to_i < 20
        puts '[T3 Code CAD Bridge] needs SketchUp 2020 or newer; not loading.'
      else
        extension = SketchupExtension.new('T3 Code CAD Bridge', 't3_cad_bridge/main')
        extension.description =
          'Lets agents in T3 Code read the open model and apply the edits you ask for.'
        extension.version = '1.2.0'
        extension.creator = 'T3 Code'
        Sketchup.register_extension(extension, true)
      end
      file_loaded(__FILE__)
    end
  end
end
