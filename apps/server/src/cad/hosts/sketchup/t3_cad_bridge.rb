# T3 Code CAD Bridge loader. T3 Code installs this file and the t3_cad_bridge
# folder into SketchUp's Plugins folder; remove both to uninstall.
require 'sketchup.rb'
require 'extensions.rb'

module T3Code
  module CadBridge
    unless file_loaded?(__FILE__)
      extension = SketchupExtension.new('T3 Code CAD Bridge', 't3_cad_bridge/main')
      extension.description =
        'Lets agents in T3 Code read the open model and apply only the edits you approve.'
      extension.version = '1.0.0'
      extension.creator = 'T3 Code'
      Sketchup.register_extension(extension, true)
      file_loaded(__FILE__)
    end
  end
end
